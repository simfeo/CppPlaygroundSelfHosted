/*
 * The page's half of the debugger.
 *
 * While the program is stopped the worker is parked in Atomics.wait and cannot
 * receive a message, so commands are written into the shared control block
 * instead. Breakpoints live in that same buffer as one flag per stop point,
 * which is what lets a breakpoint be set or cleared while the program is
 * running, not only while it is stopped.
 */
(function (global) {
  'use strict';

  const CMD = 0;
  const CONTINUE = 1, STEP_IN = 2, STEP_OVER = 3, STEP_OUT = 4;

  function create(options) {
    const { onStopped, onResumed, onEnded, onReady } = options;

    let ctrl = null;
    let breakpoints = null;
    let points = [];
    let byLine = new Map();        // "path:line" -> representative stop point id
    let stopped = null;
    let active = false;
    const wanted = new Set();      // what the user asked for, as "path:line"

    const key = (path, line) => path + ':' + line;
    const full = (file) => '/work/' + String(file).replace(/^\/work\//, '');

    function begin(payload) {
      points = payload.points;
      ctrl = new Int32Array(payload.sab, 0, payload.layout.headerInts);
      breakpoints = new Uint8Array(payload.sab, payload.layout.headerInts * 4,
        payload.layout.breakpointBytes);

      // One representative point per line: the lowest address, which is where
      // execution enters the line. Arming every point on a line would stop
      // several times over on one statement.
      byLine = new Map();
      points.forEach((p, id) => {
        const k = key(p.path, p.line);
        const current = byLine.get(k);
        if (current === undefined || p.address < points[current].address) byLine.set(k, id);
      });

      active = true;
      breakpoints.fill(0);
      for (const k of [...wanted]) {
        const id = byLine.get(k);
        if (id === undefined) wanted.delete(k);      // no code on that line
        else breakpoints[id] = 1;
      }
      if (onReady) onReady();
    }

    // A line with no code takes the next line that has some, the way every
    // debugger slides a breakpoint down to the next statement.
    function resolve(file, line) {
      const path = full(file);
      if (byLine.has(key(path, line))) return line;
      let best = null;
      for (const p of points) {
        if (p.path !== path || p.line < line) continue;
        if (best === null || p.line < best) best = p.line;
      }
      return best;
    }

    function toggle(file, line) {
      const path = full(file);
      const at = active ? resolve(file, line) : line;
      if (at === null) return null;
      const k = key(path, at);
      if (wanted.has(k)) {
        wanted.delete(k);
        if (active && byLine.has(k)) breakpoints[byLine.get(k)] = 0;
        return { line: at, set: false };
      }
      wanted.add(k);
      if (active && byLine.has(k)) breakpoints[byLine.get(k)] = 1;
      return { line: at, set: true };
    }

    function linesFor(file) {
      const path = full(file);
      const out = [];
      for (const k of wanted) {
        if (k.startsWith(path + ':')) out.push(Number(k.slice(path.length + 1)));
      }
      return out;
    }

    function send(command) {
      if (!ctrl || !stopped) return false;
      stopped = null;
      Atomics.store(ctrl, CMD, command);
      Atomics.notify(ctrl, CMD);
      if (onResumed) onResumed();
      return true;
    }

    return {
      begin,
      end() {
        active = false;
        stopped = null;
        ctrl = null;
        breakpoints = null;
        if (onEnded) onEnded();
      },
      onStop(payload) {
        stopped = payload;
        if (onStopped) onStopped(payload);
      },
      toggle,
      linesFor,
      continueRun: () => send(CONTINUE),
      stepIn: () => send(STEP_IN),
      stepOver: () => send(STEP_OVER),
      stepOut: () => send(STEP_OUT),
      get stopped() { return stopped; },
      get active() { return active; },
    };
  }

  global.Debugger = { create };
})(typeof window !== 'undefined' ? window : this);
