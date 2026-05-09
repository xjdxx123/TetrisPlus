// Dual-board scene layout — positions two BoardViews side-by-side
// (plan_gameplay_1.md §3.7 sub-phase 7e).
//
// In single-sim mode (the legacy path that main.js still uses) one
// BoardView attaches its three groups directly to caseGroup. In versus
// v2 we want two BoardViews — one for the player at negative-X, one
// for the opponent at positive-X — sharing the same scene but visually
// distinct. DualBoard is the thin coordination layer: it builds two
// child anchors, holds them at the right offsets, and exposes them so
// the versus composition root (`app/versus.js`) can pass them as the
// `parent` for each BoardView.
//
// Why a separate module: the offset math + per-side anchoring is
// reusable across versus, replay-side-by-side, and any future
// "spectator" UX. Keeping it in `world/` (and leaving the actual
// THREE.Group construction here) means the dual-board doesn't drag in
// versus-specific glue.
//
// Pure module: no Game internals, no DOM, just THREE.Group composition.

import * as THREE from 'three';

/**
 * @typedef {Object} DualBoardOpts
 * @property {THREE.Object3D} parent      The case (or scene) the two anchors mount under.
 * @property {number} [separation]        Horizontal distance between board centers (scene units).
 *                                          Default 18 — slightly more than one PLAY_W (10×1.4).
 * @property {string} [leftSide]          Tag for the left anchor. Default 'player'.
 * @property {string} [rightSide]         Tag for the right anchor. Default 'opponent'.
 */

/**
 * DualBoard — owns two anchor THREE.Groups that BoardView instances
 * attach into. The host pulls anchors via `dualBoard.anchorFor('player')`
 * and passes the result as the BoardView's `parent` opt.
 */
export class DualBoard {
  /** @param {DualBoardOpts} opts */
  constructor(opts) {
    if (!opts || !opts.parent) throw new Error('DualBoard requires { parent }');
    this._parent = opts.parent;
    this._separation = (typeof opts.separation === 'number' && opts.separation > 0)
      ? opts.separation
      : 18;
    this._leftSide  = opts.leftSide  || 'player';
    this._rightSide = opts.rightSide || 'opponent';

    this.leftAnchor  = new THREE.Group();
    this.rightAnchor = new THREE.Group();
    this.leftAnchor.position.x  = -this._separation / 2;
    this.rightAnchor.position.x =  this._separation / 2;
    this._parent.add(this.leftAnchor);
    this._parent.add(this.rightAnchor);
  }

  /** Look up an anchor by side tag. Returns null on unknown side. */
  anchorFor(side) {
    if (side === this._leftSide)  return this.leftAnchor;
    if (side === this._rightSide) return this.rightAnchor;
    return null;
  }

  /** Both anchors as `[left, right]` for tests / iteration. */
  anchors() {
    return [this.leftAnchor, this.rightAnchor];
  }

  /**
   * Hot-swap the separation. Useful if the host wants a "zoom out"
   * effect for spectator UX without rebuilding the scene.
   */
  setSeparation(sep) {
    if (typeof sep !== 'number' || sep <= 0) return;
    this._separation = sep;
    this.leftAnchor.position.x  = -sep / 2;
    this.rightAnchor.position.x =  sep / 2;
  }

  /** Tear down — removes anchors from parent. Children are NOT disposed. */
  dispose() {
    if (this.leftAnchor.parent)  this._parent.remove(this.leftAnchor);
    if (this.rightAnchor.parent) this._parent.remove(this.rightAnchor);
  }
}
