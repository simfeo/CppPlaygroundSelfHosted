/*
 * The run worker's half of the debugger.
 *
 * The program calls __dbg_line(id, framePointer) at every instrumented source
 * line (see dbgrewrite.js). That lands in onLine() below, on the worker thread,
 * with the program's stack still standing underneath it. Stopping is then a
 * matter of not returning: Atomics.wait parks the worker until the page stores
 * a command in the shared control block and notifies.
 *
 * The page cannot reach a parked worker with postMessage - a blocked worker
 * never returns to its event loop - so anything it needs to say while stopped
 * goes through the SharedArrayBuffer. That is why breakpoints live there as one
 * flag per stop point: checking them at every line is a single array read.
 *
 * The call stack is not taken from a JavaScript stack trace. Every line hands
 * over its frame pointer, and the wasm shadow stack grows downwards, so the
 * frames can be tracked by watching that value rise and fall. It costs a
 * comparison per line instead of building an Error, and it yields the one thing
 * a stack trace cannot: the frame base of each caller, without which none of
 * their locals can be found.
 */
(function (global) {
  'use strict';

  const HEADER_INTS = 8;

  const CMD = 0;
  const CONTINUE = 1;
  const STEP_IN = 2;
  const STEP_OVER = 3;
  const STEP_OUT = 4;

  function create(config) {
    const { post, points, info, dwarf, memory } = config;

    const bytes = HEADER_INTS * 4 + points.length;
    const sab = new SharedArrayBuffer(bytes);
    const ctrl = new Int32Array(sab, 0, HEADER_INTS);
    const breakpoints = new Uint8Array(sab, HEADER_INTS * 4, points.length);

    // Which function each stop point belongs to, resolved once so the hot path
    // never searches.
    const pointFunction = points.map(p => (dwarf ? dwarf.functionAt(p.address) : null));

    let pendingLocals = Object.create(null);   // reported just before each line

    let mode = 'run';
    let baseDepth = 0;
    let lastLine = -1;
    let lastPath = null;
    const stack = [];          // innermost last

    function track(id, framePointer) {
      const fn = pointFunction[id];
      const top = stack[stack.length - 1];
      if (top && top.fp === framePointer && top.fn === fn) { top.pointId = id; return; }

      // Returning: the shadow stack grows down, so a larger frame pointer means
      // frames have been given back.
      if (framePointer) {
        while (stack.length && stack[stack.length - 1].fp < framePointer) stack.pop();
      }
      const now = stack[stack.length - 1];
      if (now && now.fp === framePointer && now.fn === fn) { now.pointId = id; return; }
      // A function that needs no stack space shares its caller's frame pointer,
      // so identity has to come from the function itself.
      if (now && now.fp === framePointer && now.fn !== fn && !framePointer) stack.pop();
      stack.push({ fp: framePointer, fn, pointId: id, locals: null });
    }

    function localsFor(entry) {
      if (!dwarf || !entry.fn) return [];
      const buffer = memory();
      if (!buffer) return [];
      const mem = DwarfInfo.makeMemory(buffer.buffer);
      const pc = points[entry.pointId].address;
      const out = [];
      for (const variable of dwarf.localsOf(entry.fn, pc)) {
        const address = dwarf.addressOf(variable.location, entry.fp, entry.locals);
        const rendered = address === null
          ? { value: '<' + dwarf.whyNoAddress(variable.location) + '>' }
          : DwarfInfo.readValue(dwarf, variable.type, address, mem);
        out.push({
          name: variable.name,
          type: dwarf.typeName(variable.type),
          value: rendered.value,
          children: rendered.children || null,
          isParam: variable.isParam,
        });
      }
      return out;
    }

    function snapshot() {
      const frames = [];
      for (let i = stack.length - 1; i >= 0; i--) {
        const entry = stack[i];
        const point = points[entry.pointId];
        frames.push({
          name: (dwarf && entry.fn && dwarf.nameOf(entry.fn)) || '??',
          path: point.path,
          line: point.line,
          column: point.column,
          frame: entry.fp,
          locals: localsFor(entry),
        });
      }
      return frames;
    }

    function park(point) {
      post({ id: 'dbg-stopped', data: { point, frames: snapshot() } });
      Atomics.wait(ctrl, CMD, 0);
      const command = Atomics.load(ctrl, CMD);
      Atomics.store(ctrl, CMD, 0);

      lastPath = point.path;
      lastLine = point.line;
      if (command === STEP_IN) {
        mode = 'step';
      } else if (command === STEP_OVER) {
        mode = 'next';
        baseDepth = stack.length;
      } else if (command === STEP_OUT) {
        mode = 'finish';
        baseDepth = stack.length;
      } else {
        mode = 'run';
      }
      post({ id: 'dbg-running' });
    }

    function onLine(id, framePointer) {
      track(id, framePointer);
      // The __dbg_local calls for this line run immediately before this one, so
      // what they reported belongs to the frame now on top.
      stack[stack.length - 1].locals = pendingLocals;
      pendingLocals = Object.create(null);

      if (breakpoints[id]) { park(points[id]); return; }
      if (mode === 'run') return;

      const point = points[id];
      const movedOn = point.line !== lastLine || point.path !== lastPath;
      const depth = stack.length;

      if (mode === 'step') {
        if (movedOn) park(point);
      } else if (mode === 'next') {
        if (depth <= baseDepth && movedOn) park(point);
      } else if (mode === 'finish') {
        if (depth < baseDepth) park(point);
      }
    }

    return {
      onLocal(slot, value) { pendingLocals[slot] = value; },
      sab,
      layout: { headerInts: HEADER_INTS, breakpointBytes: points.length },
      onLine,
    };
  }

  global.DbgSession = { create };
})(typeof self !== 'undefined' ? self : this);
