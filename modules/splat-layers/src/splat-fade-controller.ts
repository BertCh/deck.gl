// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Opacity ramps that keep a streaming level-of-detail frontier from popping.
 *
 * ## The defect this exists to remove
 *
 * `SplatHierarchyManager` already holds a coarse parent on screen while its children load, so a
 * refinement never opens a hole. What it does not do is *cross the boundary* gradually: the frame
 * the last child becomes resident, the parent leaves the frontier and four finer pages take its
 * place at full opacity. Under a moving camera that happens somewhere on screen several times a
 * second, and every one of them is a visible snap. It reads as a bug rather than as a quadtree
 * refining, which is the one thing on screen worth noticing.
 *
 * ## Why a ramp is not enough on its own
 *
 * The obvious fix - cross-dissolve, parent ramping down while children ramp up - is worse. At the
 * midpoint both layers sit at half opacity, which composites to 75% coverage, so the clear colour
 * shows through a quarter of every patch that is changing level. A camera move changes level over
 * much of the screen at once, and across a whole scene that reads as the scene itself flashing.
 *
 * So a departing page is **held at the opacity it had** until the pages that replaced it are fully
 * up, and only then fades. Coverage never drops below what was already there:
 *
 * ```text
 *   parent  ────────────────┐ held at 1
 *                           └──────╲___ fade out
 *   children  ___╱──────────────────────  fade in
 *                ^ children complete      ^ parent released
 * ```
 *
 * ## What it costs
 *
 * One opacity-column write per page per fade step. The ramp is quantized to {@link fadeSteps}
 * levels rather than written per frame, because a few dozen pages fading at once is otherwise most
 * of the CPU a frame spends outside the renderer - and no step is visible under Gaussians that
 * already overlap their neighbours by design.
 *
 * ## Why it is safe to write the caller's opacity column
 *
 * It is not the caller's. Pages on the streaming path are produced by the hierarchy's own page
 * loader and owned by the layer's residency manager, which destroys them on eviction; nothing
 * outside the layer holds a reference. The original values are snapshotted before the first write
 * so a page that fades out and comes back is restored exactly, and a page whose opacities are all
 * the same value - which every page baked from a raster grid is - is recognized and costs no
 * snapshot at all.
 */

/**
 * The part of `GPUSplatData` a ramp touches.
 *
 * Structural rather than a direct import so the controller can be exercised without a GPU device:
 * everything here is satisfied by `GPUSplatData` as it stands.
 */
export type SplatFadeBatch = {
  /** Rows in the batch. */
  readonly length: number;
  /** Whether the residency manager has already released this page. */
  readonly destroyed: boolean;
  /** The CPU mirror the ramp reads once and then overwrites. */
  readonly source: {opacities: Float32Array};
  updateRows(rowOffset: number, update: {opacities: Float32Array}): void;
};

/** One page of the frontier, as the controller needs to see it. */
export type SplatFadeEntry<TBatch extends SplatFadeBatch = SplatFadeBatch> = {
  /** Stable hierarchy node identity. */
  id: string;
  /** Node identities from this node's parent up to its root, nearest first. */
  ancestorIds: readonly string[];
  batch: TBatch;
};

export type SplatFadeControllerProps = {
  /** Milliseconds a page appearing over nothing takes to reach full opacity. */
  fadeInDuration: number;
  /**
   * Milliseconds a page takes to disappear once it has been released.
   *
   * Shorter than the fade in, and deliberately: a released page is only ever covered by pages that
   * are already fully up, so this has to be long enough not to read as a cut and no longer. Every
   * millisecond of it is a patch of screen carrying two interleaved surfaces.
   */
  fadeOutDuration: number;
  /**
   * Longest a departed page is held for its replacements, in milliseconds.
   *
   * A backstop, not a timing. A replacement can take a second or two to arrive after a large
   * camera move, and the hold should cover that; a hold still running past this is blurring
   * finished ground for something that is not coming.
   */
  holdDuration: number;
  /** Quantization levels a ramp is written in. */
  fadeSteps?: number;
};

/** Per-page ramp state. */
type SplatFadeState<TBatch extends SplatFadeBatch> = {
  id: string;
  ancestorIds: readonly string[];
  batch: TBatch;
  /** Current opacity multiplier in `[0, 1]`. */
  alpha: number;
  /** Which way it is heading. */
  target: 0 | 1;
  /** The quantized level actually written into the rows, in `[0, fadeSteps]`. */
  written: number;
  /**
   * Original opacities, or `null` when they were all the same value.
   *
   * A raster-derived page is uniform, so this is `null` for every page of a terrain scene and the
   * snapshot costs nothing. A trained reconstruction is not, and pays four bytes a splat.
   */
  base: Float32Array | null;
  /** The value every row held, when `base` is `null`. */
  uniformOpacity: number;
  /** No longer in the frontier, but standing in for replacements that are still coming up. */
  held: boolean;
  /** Node identities the hold is waiting on, fixed the moment the page left the frontier. */
  holdFor: readonly string[] | null;
  /** When the hold started, for {@link SplatFadeControllerProps.holdDuration}. */
  heldSince: number;
};

/** Default quantization: sixteen levels is a write every other frame at 60fps over 300ms. */
const DEFAULT_FADE_STEPS = 16;

/**
 * How close to an endpoint a ramp is snapped to it.
 *
 * A ramp advances by `elapsed / duration` per frame, and a sum of those over exactly the duration
 * lands a few ulps short of 1. Left unsnapped a ramp never finishes: it stays `animating`, asks for
 * another frame forever, and never releases the page it is holding.
 */
const ALPHA_EPSILON = 1e-6;

/**
 * Scratch the ramp writes through, grown to the largest page seen and never shrunk.
 *
 * Module scope rather than per controller: a page write is fully consumed inside
 * `updateRows`, so there is never more than one live at a time, and a layer per view sharing one
 * buffer is the point.
 */
let opacityScratch = new Float32Array(0);

function getOpacityScratch(length: number): Float32Array {
  if (opacityScratch.length < length) {
    opacityScratch = new Float32Array(length);
  }
  return opacityScratch.subarray(0, length);
}

/**
 * Tracks one streaming frontier's opacity ramps and the list of pages that should be drawn.
 *
 * The draw list is the frontier plus every page still ramping down, which is what makes the hold
 * mean anything: a page the traversal has stopped asking for is still handed to the renderer until
 * its ramp reaches zero.
 */
export class SplatFadeController<TBatch extends SplatFadeBatch = SplatFadeBatch> {
  private props: SplatFadeControllerProps & {fadeSteps: number};
  /** Ramp state per page, in the order pages were first seen. */
  private states = new Map<TBatch, SplatFadeState<TBatch>>();
  /** Node identity to page, so a hold can ask whether what it waits on is up yet. */
  private byNodeId = new Map<string, SplatFadeState<TBatch>>();
  private currentDrawList: TBatch[] = [];
  /** Set while any ramp is mid-flight, so the layer knows to keep asking for frames. */
  private isAnimating = false;

  constructor(props: SplatFadeControllerProps) {
    this.props = {fadeSteps: DEFAULT_FADE_STEPS, ...props};
  }

  /** Whether ramps are configured at all; a controller with no durations is a pass-through. */
  get enabled(): boolean {
    return this.props.fadeInDuration > 0 || this.props.fadeOutDuration > 0;
  }

  /** Pages the renderer should hold: the frontier, plus everything still ramping down. */
  get drawList(): readonly TBatch[] {
    return this.currentDrawList;
  }

  /** Whether any ramp is still moving, and therefore whether another frame is needed. */
  get animating(): boolean {
    return this.isAnimating;
  }

  /** Pages held or fading, which is the share of the scene currently carrying two surfaces. */
  get lingeringCount(): number {
    let count = 0;
    for (const state of this.states.values()) {
      if (state.target === 0) {
        count++;
      }
    }
    return count;
  }

  setProps(props: SplatFadeControllerProps): void {
    this.props = {fadeSteps: DEFAULT_FADE_STEPS, ...props};
  }

  /**
   * Takes a new frontier and decides what is arriving, what is leaving, and what is being kept.
   *
   * Called when the traversal's frontier changes rather than per frame: a settled camera changes
   * neither the frontier nor, once its ramps have finished, anything here.
   */
  sync(entries: readonly SplatFadeEntry<TBatch>[], now: number): void {
    const present = new Set<TBatch>();
    for (const entry of entries) {
      present.add(entry.batch);
      const existing = this.states.get(entry.batch);
      if (existing) {
        // Back in the frontier. A page released a moment ago and asked for again turns round from
        // wherever its ramp had reached rather than restarting from zero, which is what stops a
        // camera jogged back and forth from strobing.
        existing.target = 1;
        existing.held = false;
        existing.holdFor = null;
        existing.id = entry.id;
        existing.ancestorIds = entry.ancestorIds;
        this.byNodeId.set(entry.id, existing);
        continue;
      }
      const state = this._createState(entry);
      this.states.set(entry.batch, state);
      this.byNodeId.set(entry.id, state);
      // Written immediately, not on the next tick: a page handed to the renderer before its first
      // ramp step would draw one frame at full opacity, which is the pop this exists to remove.
      this._write(state);
    }

    // Indexed once rather than scanned per departure. A fast camera move retires a hundred pages
    // against a frontier of several hundred, and matching those pairwise is hundreds of thousands
    // of identity comparisons in a frame; this is one pass over the frontier's ancestor chains.
    let descendantsByAncestorId: Map<string, string[]> | undefined;
    let frontierIds: Set<string> | undefined;

    for (const state of this.states.values()) {
      if (present.has(state.batch) || state.target === 0) {
        continue;
      }
      if (!descendantsByAncestorId) {
        descendantsByAncestorId = new Map();
        frontierIds = new Set();
        for (const entry of entries) {
          frontierIds.add(entry.id);
          for (const ancestorId of entry.ancestorIds) {
            const existing = descendantsByAncestorId.get(ancestorId);
            if (existing) {
              existing.push(entry.id);
            } else {
              descendantsByAncestorId.set(ancestorId, [entry.id]);
            }
          }
        }
      }

      // What replaced it is whatever the new frontier holds along the same branch: its descendants
      // on a split, its ancestor on a merge. That set is fixed here rather than recomputed, so a
      // hold cannot be extended indefinitely by pages arriving later for somewhere else.
      const replacementIds = [
        ...(descendantsByAncestorId.get(state.id) ?? []),
        ...state.ancestorIds.filter(id => frontierIds!.has(id))
      ];
      const holdFor = replacementIds.filter(id => (this.byNodeId.get(id)?.alpha ?? 0) < 1);
      state.target = 0;
      state.held = holdFor.length > 0;
      state.holdFor = state.held ? holdFor : null;
      state.heldSince = now;
    }

    this._rebuildDrawList(entries);
    this.isAnimating = true;
  }

  /**
   * Advances every ramp to `now` and writes the ones that crossed a quantization step.
   *
   * @returns whether anything is still moving.
   */
  advance(now: number, elapsedMs: number): boolean {
    const {fadeInDuration, fadeOutDuration, holdDuration} = this.props;
    let animating = false;
    let drawListChanged = false;

    for (const state of this.states.values()) {
      if (state.batch.destroyed) {
        // Evicted underneath us. Pages the controller is drawing are pinned, so this is a
        // last-resort guard rather than an expected path.
        this.states.delete(state.batch);
        if (this.byNodeId.get(state.id) === state) {
          this.byNodeId.delete(state.id);
        }
        drawListChanged = true;
        continue;
      }

      if (state.held) {
        if (this._isHoldSatisfied(state, now, holdDuration)) {
          state.held = false;
          state.holdFor = null;
        } else {
          // A hold is not a pause in a ramp, it is a page at the coverage it already had.
          animating = true;
          continue;
        }
      }

      const duration = state.target === 1 ? fadeInDuration : fadeOutDuration;
      const step = duration > 0 ? elapsedMs / duration : 1;
      const previous = state.alpha;
      const next = state.target === 1 ? state.alpha + step : state.alpha - step;
      state.alpha =
        state.target === 1
          ? next >= 1 - ALPHA_EPSILON
            ? 1
            : next
          : next <= ALPHA_EPSILON
            ? 0
            : next;
      if (state.alpha !== previous) {
        this._write(state);
      }
      if (state.target === 0 && state.alpha === 0) {
        this.states.delete(state.batch);
        if (this.byNodeId.get(state.id) === state) {
          this.byNodeId.delete(state.id);
        }
        drawListChanged = true;
        continue;
      }
      if (state.alpha !== state.target) {
        animating = true;
      }
    }

    if (drawListChanged) {
      this._rebuildDrawList();
    }
    this.isAnimating = animating;
    return animating;
  }

  /**
   * Current opacity multiplier of a page.
   *
   * `1` for a page the controller is not managing, which covers both a page it has never seen and
   * one whose ramp has finished and been forgotten - in both cases the page is drawn at the
   * opacities it carries. Use {@link isLingering} to ask whether a page is on its way out.
   */
  getAlpha(batch: TBatch): number {
    return this.states.get(batch)?.alpha ?? 1;
  }

  /** Whether a page is being drawn only to cover for something that has replaced it. */
  isLingering(batch: TBatch): boolean {
    return this.states.get(batch)?.target === 0;
  }

  /**
   * Forgets every ramp, restoring the opacities of pages that are still alive.
   *
   * Called when the scene is released. A page mid-ramp whose values were left scaled would come
   * back dim if the caller held onto it, and the resident path does exactly that.
   */
  reset(): void {
    for (const state of this.states.values()) {
      if (!state.batch.destroyed && state.written !== this.props.fadeSteps) {
        state.alpha = 1;
        this._write(state);
      }
    }
    this.states.clear();
    this.byNodeId.clear();
    this.currentDrawList = [];
    this.isAnimating = false;
  }

  /**
   * Snapshots a page's opacities and starts it at zero.
   *
   * The uniformity test is what keeps a terrain scene free of snapshots: every page baked from a
   * raster grid carries one opacity for every row, so the original is a single number.
   */
  private _createState(entry: SplatFadeEntry<TBatch>): SplatFadeState<TBatch> {
    const {opacities} = entry.batch.source;
    const first = opacities.length > 0 ? opacities[0] : 1;
    let uniform = true;
    for (let index = 1; index < opacities.length; index++) {
      if (opacities[index] !== first) {
        uniform = false;
        break;
      }
    }
    return {
      id: entry.id,
      ancestorIds: entry.ancestorIds,
      batch: entry.batch,
      alpha: 0,
      target: 1,
      // Deliberately not 0: the first `_write` must run, and it only runs on a changed level.
      written: -1,
      base: uniform ? null : opacities.slice(),
      uniformOpacity: uniform ? first : 1,
      held: false,
      holdFor: null,
      heldSince: 0
    };
  }

  /** Writes a ramp's current level into the page's opacity rows, if it moved a whole step. */
  private _write(state: SplatFadeState<TBatch>): void {
    const {fadeSteps} = this.props;
    const level = Math.round(state.alpha * fadeSteps);
    if (level === state.written || state.batch.destroyed) {
      return;
    }
    state.written = level;
    const alpha = level / fadeSteps;
    const {length} = state.batch;
    const values = getOpacityScratch(length);
    if (state.base) {
      for (let index = 0; index < length; index++) {
        values[index] = state.base[index] * alpha;
      }
    } else {
      values.fill(state.uniformOpacity * alpha);
    }
    state.batch.updateRows(0, {opacities: values});
  }

  /**
   * Whether a held page may start fading.
   *
   * Satisfied when everything it waits on is fully up, or has itself left, or the backstop has
   * expired. "Has itself left" matters: a replacement that was evicted or culled before it
   * finished arriving is never going to reach full opacity, and a hold waiting on it forever would
   * keep a coarse page over ground that has moved on.
   */
  private _isHoldSatisfied(
    state: SplatFadeState<TBatch>,
    now: number,
    holdDuration: number
  ): boolean {
    if (now - state.heldSince >= holdDuration) {
      return true;
    }
    for (const id of state.holdFor ?? []) {
      const replacement = this.byNodeId.get(id);
      if (replacement && replacement.target === 1 && replacement.alpha < 1) {
        return false;
      }
    }
    return true;
  }

  /**
   * Rebuilds the list handed to the renderer: the frontier first, then everything ramping down.
   *
   * Frontier order is preserved so a settled scene hands the renderer the same list it had, which
   * `setProps({data})` compares element-wise and skips.
   */
  private _rebuildDrawList(entries?: readonly SplatFadeEntry<TBatch>[]): void {
    const frontier = entries
      ? entries.map(entry => entry.batch)
      : this.currentDrawList.filter(batch => !this.isLingering(batch) && this.states.has(batch));
    const drawList: TBatch[] = [];
    const seen = new Set<TBatch>();
    for (const batch of frontier) {
      if (!batch.destroyed && !seen.has(batch)) {
        seen.add(batch);
        drawList.push(batch);
      }
    }
    for (const state of this.states.values()) {
      if (state.target === 0 && !state.batch.destroyed && !seen.has(state.batch)) {
        seen.add(state.batch);
        drawList.push(state.batch);
      }
    }
    this.currentDrawList = drawList;
  }
}
