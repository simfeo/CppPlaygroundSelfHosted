/*
 * Draggable splitters: file list | editor | output horizontally, and output |
 * arguments+stdin vertically. Sizes persist, so the layout you set is the
 * layout you get next time.
 */
(function (global) {
  'use strict';

  const KEY = 'cpp-playground.layout';
  // Below this the panes stack (see app.css) and stored widths would fight the
  // stylesheet, since an inline width beats a media query.
  const STACKED = '(max-width: 700px)';
  const MIN_SIDEBAR = 120, MAX_SIDEBAR = 500;
  const MIN_IO = 260, MIN_EDITOR = 240;  // MIN_IO matches #ioPane's CSS min-width
  const MIN_BOTTOM = 60, MIN_CONSOLE = 80;

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      if (saved && typeof saved === 'object') return saved;
    } catch (e) { /* defaults below */ }
    return {};
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // onResize runs after every change so the editor can re-measure itself.
  function init(opts) {
    const { main, sidebar, ioPane, ioBottom, leftHandle, rightHandle, bottomHandle,
      onResize } = opts;
    const layout = load();
    const stacked = () => window.matchMedia(STACKED).matches;

    function save() {
      if (stacked()) return;  // heights here are the stylesheet's, not the user's
      try {
        localStorage.setItem(KEY, JSON.stringify({
          sidebar: sidebar.getBoundingClientRect().width,
          io: ioPane.getBoundingClientRect().width,
          bottom: ioBottom.getBoundingClientRect().height,
        }));
      } catch (e) { /* quota */ }
    }

    function setSidebar(width) {
      sidebar.style.width = `${clamp(width, MIN_SIDEBAR, MAX_SIDEBAR)}px`;
    }

    function setIo(width) {
      const available = main.getBoundingClientRect().width
        - sidebar.getBoundingClientRect().width - MIN_EDITOR;
      ioPane.style.width = `${clamp(width, MIN_IO, Math.max(MIN_IO, available))}px`;
    }

    function setBottom(height) {
      const available = ioPane.getBoundingClientRect().height - MIN_CONSOLE;
      ioBottom.style.height = `${clamp(height, MIN_BOTTOM, Math.max(MIN_BOTTOM, available))}px`;
    }

    // Restores the horizontal split, or hands it back to the stylesheet while
    // stacked. Runs on load and whenever the window crosses the breakpoint.
    function applyWidths() {
      if (stacked()) {
        sidebar.style.width = '';
        ioPane.style.width = '';
        return;
      }
      if (layout.sidebar) setSidebar(layout.sidebar);
      if (layout.io) setIo(layout.io);
    }

    applyWidths();
    if (layout.bottom) setBottom(layout.bottom);

    function drag(handle, vertical, onMove) {
      if (!handle) return;
      handle.addEventListener('pointerdown', event => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        document.body.classList.add(vertical ? 'dragging-y' : 'dragging');

        const move = e => { onMove(vertical ? e.clientY : e.clientX); if (onResize) onResize(); };
        const up = () => {
          handle.releasePointerCapture(event.pointerId);
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          document.body.classList.remove(vertical ? 'dragging-y' : 'dragging');
          save();
          if (onResize) onResize();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
      });

      // Double-click any handle to go back to the default proportions.
      handle.addEventListener('dblclick', () => {
        sidebar.style.width = '';
        ioPane.style.width = '';
        ioBottom.style.height = '';
        localStorage.removeItem(KEY);
        if (onResize) onResize();
      });
    }

    drag(leftHandle, false, x => setSidebar(x - main.getBoundingClientRect().left));
    drag(rightHandle, false, x => setIo(main.getBoundingClientRect().right - x));
    drag(bottomHandle, true, y => setBottom(ioPane.getBoundingClientRect().bottom - y));

    window.addEventListener('resize', () => {
      // Keep the panes inside the window when it shrinks.
      applyWidths();
      if (!stacked()) setIo(ioPane.getBoundingClientRect().width);
      setBottom(ioBottom.getBoundingClientRect().height);
      if (onResize) onResize();
    });
  }

  global.Panels = { init };
})(typeof self !== 'undefined' ? self : this);
