// Liquid Glass — vanilla port of the Apple-style "Liquid Glass" effect
// from rdev/liquid-glass-react (MIT). Same SVG filter chain (feImage →
// 3-channel feDisplacementMap for chromatic aberration → screen blend →
// edge-mask composite), exposed as a tiny helper that wraps existing
// DOM elements instead of as a React component.
//
// The actual refraction comes from an `<svg>` filter living off-screen;
// each panel that wants the effect points its CSS `filter:` at the same
// filter id. We share one filter instance across all panels to keep the
// SVG cost flat — the filter region is element-scoped, so the same
// filter on N elements gives N independent refraction results.
//
// Browser support:
//   - Chrome / Edge: full effect.
//   - Safari (desktop + iOS): feDisplacementMap renders but with some
//     coordinate-system quirks. Looks usable but slightly different.
//   - Firefox: `feImage` inside feDisplacementMap is unreliable; we
//     auto-disable (host element falls back to its existing backdrop
//     blur, no filter applied).
//
// Usage:
//   installLiquidGlassFilter({ id: 'lg-default', displacementScale: 70 });
//   applyLiquidGlass(panelEl, { filterId: 'lg-default' });
//
// `applyLiquidGlass` mutates the element's inline style; the host owns
// the rest of the element (children, classes, transform). The function
// returns a `dispose()` callback that restores the previous styles —
// useful if the spike needs to be A/B'd at runtime.

import { displacementMap, polarDisplacementMap } from './liquid-glass-maps.js';

export const MAPS = {
  standard: displacementMap,
  polar:    polarDisplacementMap,
};

const SVG_NS = 'http://www.w3.org/2000/svg';

const _installedFilters = new Set();
let _stylesInstalled = false;

/**
 * Install the shared CSS for hover / pressed states. Idempotent. Called
 * automatically by applyLiquidGlass; safe to call explicitly too.
 *
 * Why CSS instead of inline-style toggling: hover state is a media-query
 * concern (so it auto-skips on touch where `:hover` doesn't fire), and
 * scoping the animation to a class lets the panel-inner content keep its
 * own transform animations (panel-jitter / score-pulse) without fighting
 * us — we only animate the warp.
 */
function installLiquidGlassStyles() {
  if (_stylesInstalled) return;
  if (typeof document === 'undefined') return;
  _stylesInstalled = true;

  const css = `
    .liquid-glass-host {
      cursor: grab;
    }
    .liquid-glass-host.is-glass-active {
      cursor: grabbing;
    }
    /* Scale targets: the warp (frosted background layer) AND every
       direct content child (e.g. .panel-inner), so text + chrome shrink
       together. Direct-child selector keeps grandchildren — which may
       have their own transforms — untouched. */
    .liquid-glass-host .liquid-glass-warp,
    .liquid-glass-host > :not(.liquid-glass-warp) {
      transform-origin: center center;
      transition: transform 220ms cubic-bezier(0.2, 0.7, 0.2, 1);
      will-change: transform;
    }
    .liquid-glass-host .liquid-glass-warp {
      transition:
        transform 220ms cubic-bezier(0.2, 0.7, 0.2, 1),
        box-shadow 220ms ease,
        background 220ms ease,
        filter 220ms ease;
      will-change: transform, filter;
    }
    /* Hover-only — :hover is silently skipped on coarse pointers, so
       phones / tablets don't get a stuck-zoom state on touch. */
    @media (hover: hover) {
      .liquid-glass-host:hover .liquid-glass-warp,
      .liquid-glass-host:hover > :not(.liquid-glass-warp) {
        transform: scale(1.08);
      }
      .liquid-glass-host:hover .liquid-glass-warp {
        filter: var(--lg-filter, none) brightness(1.12) saturate(1.08);
        -webkit-filter: var(--lg-filter, none) brightness(1.12) saturate(1.08);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.32),
          inset 0 -1px 0 rgba(0, 0, 0, 0.24),
          inset 0 0 24px rgba(108, 240, 255, 0.12);
      }
    }
    /* Pressed / dragging — same on touch + mouse. Snap (80ms) on the
       way in, ease back. The cyan-tinted inner shadow gives a "I'm
       grabbing this" feel. */
    .liquid-glass-host.is-glass-active .liquid-glass-warp,
    .liquid-glass-host.is-glass-active > :not(.liquid-glass-warp) {
      transform: scale(0.88);
      transition: transform 80ms cubic-bezier(0.4, 0.0, 0.2, 1);
    }
    .liquid-glass-host.is-glass-active .liquid-glass-warp {
      transition:
        transform 80ms cubic-bezier(0.4, 0.0, 0.2, 1),
        box-shadow 80ms ease,
        filter 80ms ease;
      filter: var(--lg-filter, none) brightness(0.95) saturate(1.10);
      -webkit-filter: var(--lg-filter, none) brightness(0.95) saturate(1.10);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.44),
        inset 0 -1px 0 rgba(0, 0, 0, 0.30),
        inset 0 0 32px rgba(108, 240, 255, 0.22);
    }
  `;
  const style = document.createElement('style');
  style.id = 'liquid-glass-style';
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * @returns {boolean} true if the runtime is expected to render the
 *   displacement chain correctly. Firefox returns false (feImage inside
 *   filter has historic bugs); everywhere else returns true and the
 *   filter is applied. Safari is treated as supported — it renders, with
 *   minor visual differences vs. Chrome.
 */
export function isLiquidGlassSupported() {
  if (typeof navigator === 'undefined') return false;
  const ua = (navigator.userAgent || '').toLowerCase();
  if (ua.includes('firefox')) return false;
  return true;
}

/**
 * Inject the SVG filter into the document. Idempotent — subsequent
 * calls with the same id return without rebuilding.
 *
 * @param {Object} [opts]
 * @param {string} [opts.id='liquid-glass']  Filter element id; the
 *   panel's CSS `filter:` value should be `url(#<id>)`.
 * @param {number} [opts.displacementScale=70]
 *   Pixel intensity of the refraction. Higher = more warp. Library
 *   default is 70; we go a touch lower (50) for HUD panels so text
 *   stays legible.
 * @param {number} [opts.aberrationIntensity=2]
 *   Strength of the per-channel scale offset that produces colour
 *   fringing at the edges. 0 disables aberration.
 * @param {keyof typeof MAPS} [opts.map='standard']
 *   Which displacement map to use. `standard` is the default cushion
 *   warp; `polar` gives a more spherical fish-eye feel.
 * @returns {string} the filter id (whatever was passed, defaulted).
 */
export function installLiquidGlassFilter({
  id = 'liquid-glass',
  displacementScale = 50,
  aberrationIntensity = 2,
  map = 'standard',
} = {}) {
  if (_installedFilters.has(id) && document.getElementById(id)) return id;
  if (typeof document === 'undefined') return id;

  // Remove any prior version with the same id (allows hot-swap from the
  // console: installLiquidGlassFilter({ displacementScale: 90 })).
  const existing = document.getElementById(id);
  if (existing && existing.parentElement) existing.parentElement.remove();

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute; width:0; height:0; pointer-events:none; overflow:hidden;';

  const mapUrl = MAPS[map] || MAPS.standard;
  const blurStd = Math.max(0.1, 0.5 - aberrationIntensity * 0.1);
  // Scales: red is the reference, green/blue get progressively smaller
  // negative scales so each channel ends up sampled from a slightly
  // different offset — the screen-blend recombination at the edges
  // produces chromatic fringes. Negative because the displacement map
  // is encoded for the "standard" mode.
  const sR = -displacementScale;
  const sG = -displacementScale * (1 + aberrationIntensity * 0.05);
  const sB = -displacementScale * (1 + aberrationIntensity * 0.10);

  svg.innerHTML = `
    <defs>
      <filter id="${id}" x="-35%" y="-35%" width="170%" height="170%" color-interpolation-filters="sRGB">
        <feImage x="0" y="0" width="100%" height="100%" result="DISPLACEMENT_MAP"
                 href="${mapUrl}" preserveAspectRatio="xMidYMid slice" />

        <feColorMatrix in="DISPLACEMENT_MAP" type="matrix"
          values="0.3 0.3 0.3 0 0
                  0.3 0.3 0.3 0 0
                  0.3 0.3 0.3 0 0
                  0   0   0   1 0"
          result="EDGE_INTENSITY" />
        <feComponentTransfer in="EDGE_INTENSITY" result="EDGE_MASK">
          <feFuncA type="discrete" tableValues="0 ${aberrationIntensity * 0.05} 1" />
        </feComponentTransfer>

        <feOffset in="SourceGraphic" dx="0" dy="0" result="CENTER_ORIGINAL" />

        <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP"
          scale="${sR}" xChannelSelector="R" yChannelSelector="B" result="RED_DISPLACED" />
        <feColorMatrix in="RED_DISPLACED" type="matrix"
          values="1 0 0 0 0
                  0 0 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0"
          result="RED_CHANNEL" />

        <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP"
          scale="${sG}" xChannelSelector="R" yChannelSelector="B" result="GREEN_DISPLACED" />
        <feColorMatrix in="GREEN_DISPLACED" type="matrix"
          values="0 0 0 0 0
                  0 1 0 0 0
                  0 0 0 0 0
                  0 0 0 1 0"
          result="GREEN_CHANNEL" />

        <feDisplacementMap in="SourceGraphic" in2="DISPLACEMENT_MAP"
          scale="${sB}" xChannelSelector="R" yChannelSelector="B" result="BLUE_DISPLACED" />
        <feColorMatrix in="BLUE_DISPLACED" type="matrix"
          values="0 0 0 0 0
                  0 0 0 0 0
                  0 0 1 0 0
                  0 0 0 1 0"
          result="BLUE_CHANNEL" />

        <feBlend in="GREEN_CHANNEL" in2="BLUE_CHANNEL" mode="screen" result="GB_COMBINED" />
        <feBlend in="RED_CHANNEL" in2="GB_COMBINED" mode="screen" result="RGB_COMBINED" />

        <feGaussianBlur in="RGB_COMBINED" stdDeviation="${blurStd}" result="ABERRATED_BLURRED" />

        <feComposite in="ABERRATED_BLURRED" in2="EDGE_MASK" operator="in" result="EDGE_ABERRATION" />

        <feComponentTransfer in="EDGE_MASK" result="INVERTED_MASK">
          <feFuncA type="table" tableValues="1 0" />
        </feComponentTransfer>
        <feComposite in="CENTER_ORIGINAL" in2="INVERTED_MASK" operator="in" result="CENTER_CLEAN" />

        <feComposite in="EDGE_ABERRATION" in2="CENTER_CLEAN" operator="over" />
      </filter>
    </defs>
  `;

  // The SVG itself doesn't render anything; we just need it in the
  // document for the filter to resolve. Append to body so it sits
  // outside the CSS3D / WebGL stacking contexts.
  document.body.appendChild(svg);
  _installedFilters.add(id);
  return id;
}

/**
 * Apply Liquid Glass styling to an existing element. Injects an inner
 * `.liquid-glass-warp` div that carries the SVG filter + backdrop-filter
 * + border + inner shadows; the outer element stays a plain
 * (transparent) container so its CSS3D transform stack — and therefore
 * its z-order against the WebGL canvas — keeps working.
 *
 * Why the inner-warp pattern matters:
 *   Applying `filter: url(...)` directly to the outer element creates
 *   a new stacking context AND promotes that element to its own
 *   compositor layer. For CSS3DObject-mounted panels that breaks block
 *   occlusion (panel always renders in front of WebGL content) and
 *   subtly changes wheel-event coordinate sampling. The library's
 *   `.glass__warp` span sidesteps both because the filter is on a child
 *   that stays inside the parent's 3D-transformed coordinate space.
 *
 * @param {HTMLElement} el
 * @param {Object} [opts]
 * @param {string} [opts.filterId='liquid-glass']
 * @param {number} [opts.blurAmount=0.0625]   Library-equivalent; final
 *   CSS `blur()` is `(4 + blurAmount * 32) px` ≈ 6 px at the default.
 * @param {number} [opts.saturation=180]      Backdrop saturation %.
 * @param {number} [opts.cornerRadius=14]     px.
 * @param {boolean} [opts.overLight=false]    Bumps the inner shadow for
 *   panels that sit over a bright background.
 * @param {string} [opts.tint]                Warp background CSS. Default
 *   is `rgba(255,255,255,0.03)` (clear). Pass a heavier dark fill (e.g.
 *   the original frosted gradient) to read as "frosted glass" while
 *   still getting the SVG displacement at the edges.
 * @returns {() => void}                       restore-prior-styles fn
 */
export function applyLiquidGlass(el, opts = {}) {
  if (!el) return () => {};
  if (!isLiquidGlassSupported()) return () => {};
  installLiquidGlassStyles();

  const {
    filterId = 'liquid-glass',
    blurAmount = 0.0625,
    saturation = 180,
    cornerRadius = 14,
    overLight = false,
    tint = 'rgba(255, 255, 255, 0.03)',
  } = opts;

  const blurPx = (overLight ? 12 : 4) + blurAmount * 32;
  const filterRef = `url(#${filterId})`;

  // Snapshot outer styles we'll override so dispose() can restore them.
  const outerProps = [
    'background', 'border', 'borderRadius', 'overflow',
    'boxShadow', 'backdropFilter', 'webkitBackdropFilter',
    'filter', 'webkitFilter', 'position',
  ];
  const priorOuter = {};
  for (const p of outerProps) priorOuter[p] = el.style[p];

  // Outer goes transparent. The drop shadow stays on the outer (so it
  // sits BELOW the clip rectangle — inset shadows would be clipped
  // out). overflow stays VISIBLE so hover scale(>1) on the warp and
  // content children can extend past the original host box. The warp
  // already carries its own border-radius, so corners stay rounded
  // without the host clipping.
  el.style.background = 'transparent';
  el.style.border = '0';
  el.style.borderRadius = `${cornerRadius}px`;
  el.style.overflow = 'visible';
  el.style.backdropFilter = 'none';
  el.style.webkitBackdropFilter = 'none';
  el.style.filter = 'none';
  el.style.webkitFilter = 'none';
  if (!el.style.position) el.style.position = 'relative';
  el.style.boxShadow = overLight
    ? '0 16px 70px rgba(0, 0, 0, 0.55)'
    : '0 12px 40px rgba(0, 0, 0, 0.45)';

  // Tag the outer so :hover / .is-glass-active CSS rules apply, and
  // expose the filter URL as a custom property so the stylesheet's
  // hover state can compose it with brightness() / saturate().
  el.classList.add('liquid-glass-host');
  el.style.setProperty('--lg-filter', filterRef);

  // Inject the warp at the front of the child list so it sits visually
  // BEHIND existing content. The content layer (.panel-inner or
  // whatever the panel uses) gets a z-index bump to stay on top.
  const warp = document.createElement('div');
  warp.className = 'liquid-glass-warp';
  warp.setAttribute('aria-hidden', 'true');
  // Use `var(--lg-filter)` (inherited from the host) so the stylesheet
  // can compose extra filter functions in :hover / .is-glass-active.
  warp.style.cssText = `
    position: absolute;
    inset: 0;
    pointer-events: none;
    border-radius: ${cornerRadius}px;
    background: ${tint};
    border: 1px solid rgba(255, 255, 255, 0.18);
    filter: var(--lg-filter);
    -webkit-filter: var(--lg-filter);
    backdrop-filter: blur(${blurPx}px) saturate(${saturation}%);
    -webkit-backdrop-filter: blur(${blurPx}px) saturate(${saturation}%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.20),
      inset 0 -1px 0 rgba(0, 0, 0, 0.22);
  `;
  el.insertBefore(warp, el.firstChild);

  // Lift the first non-warp child (typically `.panel-inner`) above the
  // warp via stacking. Without this, the warp's transparent background
  // is fine but anything that the warp's filter samples (the children
  // themselves) would render under it.
  const content = warp.nextElementSibling;
  let priorContent = null;
  if (content) {
    priorContent = { position: content.style.position, zIndex: content.style.zIndex };
    if (!content.style.position) content.style.position = 'relative';
    content.style.zIndex = '1';
  }

  // Pressed / dragging feedback — toggle `is-glass-active` on the host
  // for the CSS .is-glass-active rule. We do NOT swallow the events:
  // existing drag/orbit listeners on the panel still see them.
  const onDown = () => el.classList.add('is-glass-active');
  const onUp   = () => el.classList.remove('is-glass-active');
  el.addEventListener('pointerdown',   onDown);
  el.addEventListener('pointerup',     onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('pointerleave',  onUp);

  return () => {
    el.removeEventListener('pointerdown',   onDown);
    el.removeEventListener('pointerup',     onUp);
    el.removeEventListener('pointercancel', onUp);
    el.removeEventListener('pointerleave',  onUp);
    el.classList.remove('liquid-glass-host', 'is-glass-active');
    el.style.removeProperty('--lg-filter');
    if (warp.parentElement) warp.parentElement.removeChild(warp);
    if (content && priorContent) {
      content.style.position = priorContent.position;
      content.style.zIndex   = priorContent.zIndex;
    }
    for (const p of outerProps) el.style[p] = priorOuter[p] || '';
  };
}
