/* tiles.js — Tile pool manager for the profile wizard narrative step.
 *
 * Exposed as window.TileManager (plain browser script, no bundler).
 *
 * Usage:
 *   const mgr = new TileManager({ pool, gridEl, trayEl, textareaEl, type });
 *   mgr.init();
 */

class TileManager {
  /**
   * @param {object} opts
   * @param {string[]}   opts.pool       - Full list of chip labels for this section
   * @param {HTMLElement} opts.gridEl    - Container where the 8 active tiles render
   * @param {HTMLElement} opts.trayEl    - Container where selected tiles collect
   * @param {HTMLElement} opts.textareaEl - Editable textarea that mirrors selected labels
   * @param {'feature'|'deal_breaker'} opts.type - Sent to /api/suggest-tile
   */
  constructor({ pool, gridEl, trayEl, textareaEl, type }) {
    this._fullPool = [...pool];
    this._remainingPool = [...pool];
    this._grid = [];       // labels currently shown as clickable tiles
    this._selected = [];   // labels the user has picked
    this._gridEl = gridEl;
    this._trayEl = trayEl;
    this._textareaEl = textareaEl;
    this._type = type;
    this._inFlightSlots = new Set(); // slots currently awaiting AI suggestion
  }

  /** Shuffle an array in-place (Fisher-Yates). */
  static _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Initialise the grid from the pool, respecting any pre-selected labels. */
  init(preSelected = []) {
    // Remove pre-selected from pool so they don't appear as clickable tiles
    const preSet = new Set(preSelected.map((s) => s.toLowerCase()));
    this._remainingPool = TileManager._shuffle(
      this._fullPool.filter((label) => !preSet.has(label.toLowerCase()))
    );
    this._selected = [...preSelected];
    this._grid = this._remainingPool.splice(0, 8);
    this._renderTray();
    this._renderGrid();
  }

  /** Called when the user clicks a tile at grid index i. */
  async pick(index) {
    if (index < 0 || index >= this._grid.length) return;
    if (this._inFlightSlots.has(index)) return;

    const label = this._grid[index];
    const chipEl = this._gridEl.children[index];
    if (!chipEl) return;

    // 1. Fly the chip to the tray
    chipEl.classList.add('chip-fly-out');

    // 2. Add to selected and update textarea immediately (responsive feel)
    this._selected.push(label);
    this._syncTextarea();
    this._renderTray();

    // 3. Mark slot as loading while we wait for the AI suggestion
    this._inFlightSlots.add(index);

    // 4. After fly animation, clear the slot and show loading placeholder
    const flySlot = index;
    setTimeout(() => {
      // Only blank the slot if it is still awaiting a suggestion (not already filled)
      if (this._inFlightSlots.has(flySlot)) {
        this._grid[flySlot] = null;
        this._renderGrid();
      }
    }, 220);

    // 5. Fetch AI suggestion (falls back to random pool item)
    const suggestion = await this._fetchSuggestion();

    // 6. Fill the slot
    this._inFlightSlots.delete(index);
    if (suggestion) {
      this._grid[index] = suggestion;
      // Remove suggestion from remainingPool if it's there
      const idx = this._remainingPool.indexOf(suggestion);
      if (idx !== -1) this._remainingPool.splice(idx, 1);
    } else if (this._remainingPool.length > 0) {
      this._grid[index] = this._remainingPool.shift();
    } else {
      // Pool exhausted — remove the slot so the grid shrinks
      this._grid.splice(index, 1);
    }

    this._renderGrid();

    // 7. Animate the new chip in
    const newChipEl = this._gridEl.children[index];
    if (newChipEl) {
      newChipEl.classList.add('chip-pop-in');
      setTimeout(() => newChipEl.classList.remove('chip-pop-in'), 350);
    }
  }

  /** POST /api/suggest-tile and return the suggested label, or null on failure. */
  async _fetchSuggestion() {
    try {
      const res = await fetch('/api/suggest-tile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selected: this._selected,
          pool: this._remainingPool.filter(Boolean),
          type: this._type,
        }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return typeof data.suggestion === 'string' && data.suggestion.trim()
        ? data.suggestion.trim()
        : null;
    } catch {
      return null;
    }
  }

  /** Sync the editable textarea with the current selected list. */
  _syncTextarea() {
    if (!this._textareaEl) return;
    const current = this._textareaEl.value.trim();
    // Append any newly selected label not already present
    const lastSelected = this._selected[this._selected.length - 1];
    if (!lastSelected) return;
    if (current.toLowerCase().includes(lastSelected.toLowerCase())) return;
    const needsSep = current.length > 0 && !/[.,;]\s*$/.test(current);
    this._textareaEl.value = current.length === 0
      ? `${lastSelected}.`
      : needsSep
        ? `${current}, ${lastSelected}.`
        : `${current} ${lastSelected}.`;
    this._textareaEl.dispatchEvent(new Event('input'));
  }

  /** Re-render the tray of selected chips. */
  _renderTray() {
    if (!this._trayEl) return;
    if (this._selected.length === 0) {
      this._trayEl.innerHTML = '<span class="tile-tray-empty">None selected yet</span>';
      return;
    }
    this._trayEl.innerHTML = this._selected
      .map((label) => `<span class="chip">${this._esc(label)}</span>`)
      .join('');
  }

  /** Re-render the 8-tile clickable grid. */
  _renderGrid() {
    if (!this._gridEl) return;
    this._gridEl.innerHTML = this._grid
      .map((label, i) => {
        if (label === null) {
          return `<button type="button" class="chip chip-loading" disabled>…</button>`;
        }
        return `<button type="button" class="chip" data-tile-index="${i}">+ ${this._esc(label)}</button>`;
      })
      .join('');
    this._gridEl.querySelectorAll('[data-tile-index]').forEach((btn) => {
      btn.addEventListener('click', () => this.pick(Number(btn.dataset.tileIndex)));
    });
  }

  _esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
}

window.TileManager = TileManager;
