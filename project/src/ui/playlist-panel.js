// BGM Playlist panel — transport controls + scrollable track list.
//
// Visual language matches the existing 2D `tp-panel` chrome (effects panel,
// debug overlay) — same glass blur, cyan accent, monospace mark, SF mono
// readouts. Adds two playlist-only flavours of `tp-button` for the
// transport row and a list-row style for the track index.
//
// Pure DOM. The panel takes a playlist controller (createBgmPlaylist's
// return value) and a volume slider hook — it does not import the audio
// module directly. That keeps it testable and lets a future Vitest pass
// stub the playlist with a fake.

import { installPanelStyles, makePanelHeader } from './panel-shared.js';

let _stylesInstalled = false;

function installPlaylistStyles() {
  if (_stylesInstalled) return;
  _stylesInstalled = true;
  const css = `
    .tp-playlist__now {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px 4px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      margin-bottom: 8px;
    }
    .tp-playlist__now-label {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-size: 9px;
      color: var(--muted, #8b93ad);
      opacity: 0.7;
    }
    .tp-playlist__now-name {
      font-size: 13px;
      color: var(--accent, #6cf0ff);
      text-shadow: 0 0 14px rgba(108, 240, 255, 0.30);
      font-weight: 500;
      letter-spacing: 0.02em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* Transport row — three icon-style buttons. */
    .tp-playlist__transport {
      display: flex;
      gap: 6px;
      padding: 2px 0 6px;
    }
    .tp-playlist__btn {
      flex: 1;
      padding: 8px 0;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 5px;
      color: var(--ink, #f3f5fb);
      font-family: inherit;
      font-size: 13px;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s, background 0.15s;
      letter-spacing: 0.05em;
    }
    .tp-playlist__btn:hover {
      border-color: rgba(108, 240, 255, 0.45);
      background: rgba(108, 240, 255, 0.06);
      color: var(--accent, #6cf0ff);
    }
    .tp-playlist__btn:active { transform: translateY(1px); }
    .tp-playlist__btn--play {
      flex: 1.4;
      color: var(--accent, #6cf0ff);
      border-color: rgba(108, 240, 255, 0.50);
      background: rgba(108, 240, 255, 0.08);
    }
    /* Track list — scrollable, capped height. */
    .tp-playlist__list {
      max-height: 240px;
      overflow-y: auto;
      margin-top: 6px;
      padding-right: 2px; /* room for scrollbar */
      scrollbar-width: thin;
      scrollbar-color: rgba(108,240,255,0.35) rgba(255,255,255,0.04);
    }
    .tp-playlist__list::-webkit-scrollbar { width: 6px; }
    .tp-playlist__list::-webkit-scrollbar-track {
      background: rgba(255, 255, 255, 0.03);
      border-radius: 3px;
    }
    .tp-playlist__list::-webkit-scrollbar-thumb {
      background: rgba(108, 240, 255, 0.30);
      border-radius: 3px;
    }
    .tp-playlist__list::-webkit-scrollbar-thumb:hover {
      background: rgba(108, 240, 255, 0.50);
    }
    .tp-playlist__row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      color: var(--ink, #f3f5fb);
      transition: background 0.12s, color 0.12s;
    }
    .tp-playlist__row:hover { background: rgba(255, 255, 255, 0.04); }
    .tp-playlist__row.is-active {
      background: rgba(108, 240, 255, 0.10);
      color: var(--accent, #6cf0ff);
    }
    .tp-playlist__row.is-active .tp-playlist__row-num {
      color: var(--accent, #6cf0ff);
      text-shadow: 0 0 8px rgba(108, 240, 255, 0.5);
    }
    .tp-playlist__row-num {
      flex: 0 0 24px;
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 9.5px;
      letter-spacing: 0.10em;
      color: var(--muted, #8b93ad);
      font-variant-numeric: tabular-nums;
    }
    .tp-playlist__row-name {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tp-playlist__row-icon {
      flex: 0 0 14px;
      width: 14px;
      text-align: center;
      color: var(--accent, #6cf0ff);
      font-size: 10px;
      opacity: 0;
      transition: opacity 0.15s;
    }
    .tp-playlist__row.is-active .tp-playlist__row-icon { opacity: 0.95; }
  `;
  const style = document.createElement('style');
  style.id = 'tp-playlist-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * @typedef {Object} PlaylistPanelOpts
 * @property {{
 *   play():void,
 *   pause():void,
 *   next():Promise<void>|void,
 *   prev():Promise<void>|void,
 *   setTrack(i:number):Promise<void>|void,
 *   current():{index:number, track:{name:string,url:string}},
 *   tracks():Array<{name:string,url:string}>,
 *   playing:boolean,
 * }} playlist
 *
 * @property {Object} [volume]
 * @property {number} [volume.value]    Initial volume 0..1.
 * @property {(v: number) => void} [volume.onChange]
 *
 * @property {string} [hotkey='KeyM']    Toggle key.
 * @property {boolean} [visibleByDefault=false]
 *
 * @property {(playing: boolean) => () => void} [subscribePlaying]
 *   Subscribe-and-return-unsubscribe for play/pause changes from the controller.
 * @property {(idx: number, track: any) => () => void} [subscribeTrack]
 *   Subscribe-and-return-unsubscribe for track changes from the controller.
 */

/**
 * Build the playlist panel.
 * @param {PlaylistPanelOpts} opts
 */
export function createPlaylistPanel(opts) {
  const {
    playlist,
    volume = null,
    hotkey = 'KeyM',
    visibleByDefault = false,
    subscribePlaying = null,
    subscribeTrack = null,
  } = opts || {};

  if (!playlist || typeof playlist.tracks !== 'function') {
    return { setVisible() {}, dispose() {}, refresh() {} };
  }

  installPanelStyles();
  installPlaylistStyles();

  const root = document.createElement('div');
  root.id = 'playlist-panel';
  root.className = 'tp-panel';
  root.style.top = '64px';
  root.style.right = '16px';
  root.style.width = '300px';

  let visible = visibleByDefault;
  const setVisibleInternal = (v) => {
    visible = !!v;
    root.style.display = visible ? 'block' : 'none';
  };
  setVisibleInternal(visible);

  const hotkeyDisplay = hotkey.replace('Key', '').toUpperCase();
  root.appendChild(makePanelHeader({
    title: 'Music',
    hotkey: hotkeyDisplay,
    onClose: () => setVisibleInternal(false),
  }));

  const body = document.createElement('div');
  body.className = 'tp-panel__body';
  root.appendChild(body);

  // -----------------------------------------------------------------------
  // "Now playing" section.
  // -----------------------------------------------------------------------
  const now = document.createElement('div');
  now.className = 'tp-playlist__now';

  const nowLabel = document.createElement('span');
  nowLabel.className = 'tp-playlist__now-label';
  nowLabel.textContent = 'Now playing';
  now.appendChild(nowLabel);

  const nowName = document.createElement('span');
  nowName.className = 'tp-playlist__now-name';
  nowName.textContent = playlist.current().track ? playlist.current().track.name : '—';
  now.appendChild(nowName);
  body.appendChild(now);

  // -----------------------------------------------------------------------
  // Transport row.
  // -----------------------------------------------------------------------
  const transport = document.createElement('div');
  transport.className = 'tp-playlist__transport';

  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'tp-playlist__btn';
  prevBtn.title = 'Previous track';
  prevBtn.textContent = '⏮';
  prevBtn.addEventListener('click', () => playlist.prev());

  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.className = 'tp-playlist__btn tp-playlist__btn--play';
  playBtn.title = 'Play / Pause';
  playBtn.textContent = playlist.playing ? '⏸' : '▶';
  playBtn.addEventListener('click', () => {
    if (playlist.playing) playlist.pause();
    else                  playlist.play();
  });

  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'tp-playlist__btn';
  nextBtn.title = 'Next track';
  nextBtn.textContent = '⏭';
  nextBtn.addEventListener('click', () => playlist.next());

  transport.appendChild(prevBtn);
  transport.appendChild(playBtn);
  transport.appendChild(nextBtn);
  body.appendChild(transport);

  // -----------------------------------------------------------------------
  // Volume slider — uses the same tp-slider chrome as the settings panel
  // sliders (panel-shared.installPanelStyles already injected the rule).
  // The audio toggle in main.js mutes/unmutes; this slider sets the level.
  // -----------------------------------------------------------------------
  if (volume && typeof volume.onChange === 'function') {
    const divider = document.createElement('div');
    divider.className = 'tp-panel__divider';
    body.appendChild(divider);

    const row = document.createElement('div');
    row.className = 'tp-slider-row';

    const label = document.createElement('span');
    label.className = 'tp-slider-row__label';
    label.textContent = 'BGM volume';
    row.appendChild(label);

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'tp-slider';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.01';
    const initial = (typeof volume.value === 'number') ? volume.value : 0.32;
    slider.value = String(initial);

    const readout = document.createElement('span');
    readout.className = 'tp-slider-row__readout';
    readout.textContent = initial.toFixed(2);

    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      readout.textContent = v.toFixed(2);
      volume.onChange(v);
    });

    row.appendChild(slider);
    row.appendChild(readout);
    body.appendChild(row);
  }

  // -----------------------------------------------------------------------
  // Track list.
  // -----------------------------------------------------------------------
  const listLabel = document.createElement('div');
  listLabel.className = 'tp-panel__section-label';
  listLabel.textContent = 'Tracks';
  listLabel.style.marginTop = '10px';
  body.appendChild(listLabel);

  const list = document.createElement('div');
  list.className = 'tp-playlist__list';
  body.appendChild(list);

  /** @type {HTMLElement[]} */
  const rowEls = [];
  const tracks = playlist.tracks();
  tracks.forEach((track, idx) => {
    const row = document.createElement('div');
    row.className = 'tp-playlist__row';
    row.dataset.index = String(idx);

    const num = document.createElement('span');
    num.className = 'tp-playlist__row-num';
    num.textContent = String(idx + 1).padStart(2, '0');
    row.appendChild(num);

    const name = document.createElement('span');
    name.className = 'tp-playlist__row-name';
    name.textContent = track.name;
    row.appendChild(name);

    // The active marker — a small note glyph that fades in on the active row.
    const icon = document.createElement('span');
    icon.className = 'tp-playlist__row-icon';
    icon.textContent = '♪';
    row.appendChild(icon);

    row.addEventListener('click', () => playlist.setTrack(idx));
    list.appendChild(row);
    rowEls.push(row);
  });

  // -----------------------------------------------------------------------
  // Sync helpers — set active row, set transport play/pause label, etc.
  // -----------------------------------------------------------------------
  function setActiveRow(idx) {
    rowEls.forEach((el, i) => el.classList.toggle('is-active', i === idx));
    // Keep the active row visible when the panel is open.
    const active = rowEls[idx];
    if (active && visible) {
      try { active.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      catch { /* older browsers without smooth — ignore */ }
    }
    // Update the now-playing line.
    const t = tracks[idx];
    nowName.textContent = t ? t.name : '—';
  }
  setActiveRow(playlist.current().index);

  function setPlayLabel(playing) {
    playBtn.textContent = playing ? '⏸' : '▶';
    playBtn.title = playing ? 'Pause' : 'Play';
  }
  setPlayLabel(playlist.playing);

  // External subscriptions — the playlist controller fires these.
  let unsubscribePlaying = null;
  if (subscribePlaying) {
    unsubscribePlaying = subscribePlaying((playing) => setPlayLabel(playing));
  }
  let unsubscribeTrack = null;
  if (subscribeTrack) {
    unsubscribeTrack = subscribeTrack((idx) => setActiveRow(idx));
  }

  // -----------------------------------------------------------------------
  // Hotkey + insert into the document.
  // -----------------------------------------------------------------------
  document.body.appendChild(root);

  const onKey = (e) => {
    if (e.code !== hotkey) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    setVisibleInternal(!visible);
  };
  window.addEventListener('keydown', onKey);

  function refresh() {
    setActiveRow(playlist.current().index);
    setPlayLabel(playlist.playing);
  }

  function dispose() {
    window.removeEventListener('keydown', onKey);
    if (unsubscribePlaying) try { unsubscribePlaying(); } catch { /* ignore */ }
    if (unsubscribeTrack)   try { unsubscribeTrack();   } catch { /* ignore */ }
    root.remove();
  }

  return {
    setVisible: setVisibleInternal,
    refresh,
    dispose,
  };
}
