/*
 * Splices debugger stop points into a linked wasm module.
 *
 * WebAssembly gives a host no way to pause a running module, so the pause has
 * to be compiled in: at every source line of the user's own code we insert
 *
 *     i32.const <id>
 *     call      __dbg_line
 *
 * which calls out to JavaScript, where the worker can block on Atomics.wait.
 *
 * Two things make this a small rewrite rather than a general one:
 *
 *   - __dbg_line is already a defined function, supplied by runtime/throw_shim.cpp
 *     and kept alive with --export. Adding an *import* instead would push every
 *     defined function index up by one, which would mean renumbering every call,
 *     element segment, export and name-section entry in the module.
 *   - the pair pushes one i32 and immediately consumes it, so it is valid at any
 *     instruction boundary whatever the operand stack looks like there. The DWARF
 *     line table hands us exactly those boundaries.
 *
 * Only lines under /work (the user's files) are instrumented. Stepping through
 * libc++ is not what anyone wants from a playground, and it would multiply the
 * call count for no gain.
 *
 * Inserting bytes moves everything after them, so DWARF's addresses no longer
 * describe the new module. Rather than rewrite the debug sections, the result
 * carries a remap the symbolizer runs a PC through before it looks anything up.
 */
(function (global) {
  'use strict';

  const OP_I32_CONST = 0x41;
  const OP_CALL = 0x10;
  const OP_LOCAL_GET = 0x20;
  const OP_GLOBAL_GET = 0x23;
  const SECTION_CODE = 10;
  const SECTION_EXPORT = 7;

  function uleb(value) {
    const out = [];
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      out.push(byte);
    } while (value !== 0);
    return out;
  }

  // i32.const takes a signed LEB128. Our ids are small and positive, but 64
  // encodes as 0xC0 0x00 rather than 0x40, so the sign bit still has to be got
  // right or the module fails validation.
  function sleb(value) {
    const out = [];
    for (;;) {
      const byte = value & 0x7f;
      value >>= 7;
      const signBit = (byte & 0x40) !== 0;
      if ((value === 0 && !signBit) || (value === -1 && signBit)) {
        out.push(byte);
        return out;
      }
      out.push(byte | 0x80);
    }
  }

  class Reader {
    constructor(bytes, pos) { this.b = bytes; this.pos = pos || 0; }
    u8() { return this.b[this.pos++]; }
    uleb() {
      let result = 0, shift = 1, byte;
      do { byte = this.b[this.pos++]; result += (byte & 0x7f) * shift; shift *= 128; } while (byte & 0x80);
      return result;
    }
    bytes(n) { const v = this.b.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  }

  function sections(binary) {
    const r = new Reader(binary, 8);
    const found = [];
    while (r.pos < binary.length) {
      const id = r.u8();
      const size = r.uleb();
      found.push({ id, start: r.pos, end: r.pos + size });
      r.pos += size;
    }
    return found;
  }

  // The export section is the only place a function's name and index sit
  // together without decoding the name section's subsections.
  function exportedFunction(binary, section, wanted) {
    if (!section) return -1;
    const r = new Reader(binary, section.start);
    const count = r.uleb();
    for (let i = 0; i < count; i++) {
      const name = new TextDecoder('utf-8').decode(r.bytes(r.uleb()));
      const kind = r.u8();
      const index = r.uleb();
      if (kind === 0 && name === wanted) return index;
    }
    return -1;
  }

  // Body ranges of every function in the code section, as absolute offsets into
  // the module. `code` is where the instructions start, past the locals vector.
  // `declared` are the local types the body itself declares, which sit after the
  // parameters in the local index space.
  function functionBodies(binary, section) {
    const r = new Reader(binary, section.start);
    const count = r.uleb();
    const bodies = [];
    for (let i = 0; i < count; i++) {
      const size = r.uleb();
      const start = r.pos;
      const end = start + size;
      const locals = new Reader(binary, start);
      const groups = locals.uleb();
      const declared = [];
      for (let g = 0; g < groups; g++) {
        const n = locals.uleb();
        const type = locals.u8();
        for (let k = 0; k < n; k++) declared.push(type);
      }
      bodies.push({ start, end, code: locals.pos, declared });
      r.pos = end;
    }
    return bodies;
  }

  const VALTYPE_I32 = 0x7f;

  /*
   * Parameter types per defined function. A local's index space is parameters
   * first, then the body's own declarations, and only the parameters' types
   * live in the type section - so loading a local blind would risk emitting
   * local.get for an i64 where an i32 is expected, and the module would not
   * validate.
   */
  function parameterTypes(binary, found) {
    const typeSection = found.find(s => s.id === 1);
    const importSection = found.find(s => s.id === 2);
    const functionSection = found.find(s => s.id === 3);
    if (!typeSection || !functionSection) return [];

    const types = [];
    const t = new Reader(binary, typeSection.start);
    const typeCount = t.uleb();
    for (let i = 0; i < typeCount; i++) {
      const form = t.u8();
      if (form !== 0x60) { types.push([]); continue; }
      const params = [];
      const n = t.uleb();
      for (let k = 0; k < n; k++) params.push(t.u8());
      const results = t.uleb();
      for (let k = 0; k < results; k++) t.u8();
      types.push(params);
    }

    // Imported functions come first in the index space, but have no bodies, so
    // the function section lines up with the code section directly.
    let imported = 0;
    if (importSection) {
      const im = new Reader(binary, importSection.start);
      const n = im.uleb();
      for (let i = 0; i < n; i++) {
        im.bytes(im.uleb());                 // module
        im.bytes(im.uleb());                 // name
        const kind = im.u8();
        if (kind === 0) { im.uleb(); imported++; }
        else if (kind === 1) { im.u8(); const limits = im.u8(); im.uleb(); if (limits) im.uleb(); }
        else if (kind === 2) { const limits = im.u8(); im.uleb(); if (limits) im.uleb(); }
        else if (kind === 3) { im.u8(); im.u8(); }
        else if (kind === 4) { im.u8(); im.uleb(); }
      }
    }

    const perFunction = [];
    const f = new Reader(binary, functionSection.start);
    const defined = f.uleb();
    for (let i = 0; i < defined; i++) perFunction.push(types[f.uleb()] || []);
    return perFunction;
  }

  /*
   * rows: DWARF line rows, already biased to module offsets, as debuginfo.js
   * produces them. Returns the new module, the id -> location table, and the
   * offset remap.
   */
  function instrument(binary, rows, options) {
    const only = (options && options.only) || /^\/work\//;
    const found = sections(binary);
    const code = found.find(s => s.id === SECTION_CODE);
    const exports = found.find(s => s.id === SECTION_EXPORT);
    if (!code) throw new Error('module has no code section');

    const hook = exportedFunction(binary, exports, '__dbg_line');
    if (hook < 0) throw new Error('module does not export __dbg_line');

    const bodies = functionBodies(binary, code);

    // One stop point per (address, line). Several rows can share an address;
    // the first is the one that names the statement.
    const points = [];
    const byAddress = new Map();
    for (const row of rows) {
      if (row.end || !row.path || !only.test(row.path)) continue;
      if (byAddress.has(row.address)) continue;
      const body = bodies.find(b => row.address >= b.code && row.address < b.end);
      if (!body) continue;                       // outside any function body
      if (row.address === body.end - 1) continue; // the function's closing end
      byAddress.set(row.address, points.length);
      points.push({ address: row.address, path: row.path, line: row.line, column: row.column });
    }
    if (!points.length) {
      return { binary, points: [], remap: (pc) => pc, instrumented: 0 };
    }

    points.sort((a, b) => a.address - b.address);
    byAddress.clear();
    points.forEach((p, i) => byAddress.set(p.address, i));

    // Every variable is an offset from its function's frame base, and that base
    // lives in a wasm local the host cannot read. So the program hands it over:
    // each call loads the frame base and passes it as the second argument. A
    // function whose base we cannot name passes 0, and shows no locals.
    const frameBase = (options && options.frameBase) || (() => null);
    function loadFrame(body) {
      const base = frameBase(body.code);
      if (!base) return [OP_I32_CONST, 0];
      if (base.kind === 'local') return [OP_LOCAL_GET, ...uleb(base.index)];
      if (base.kind === 'global') return [OP_GLOBAL_GET, ...uleb(base.index)];
      return [OP_I32_CONST, 0];
    }

    // Locals that hold the address of a variable, reported alongside the line so
    // the debugger can find objects the frame base does not describe.
    const localSlots = (options && options.localSlots) || (() => []);
    const localHook = exportedFunction(binary, exports, '__dbg_local');
    const params = parameterTypes(binary, found);

    function localType(bodyIndex, body, index) {
      const own = params[bodyIndex] || [];
      return index < own.length ? own[index] : body.declared[index - own.length];
    }

    function reportLocals(bodyIndex, body) {
      if (localHook < 0) return [];
      const bytes = [];
      for (const index of localSlots(body.code)) {
        if (localType(bodyIndex, body, index) !== VALTYPE_I32) continue;
        bytes.push(OP_I32_CONST, ...sleb(index), OP_LOCAL_GET, ...uleb(index),
          OP_CALL, ...uleb(localHook));
      }
      return bytes;
    }

    // Rebuild the code section body by body, splicing the pairs in.
    const pieces = [];
    const shifts = [];               // {at, delta} in original-offset space
    let grown = 0;

    const newBodies = [];
    for (let bodyIndex = 0; bodyIndex < bodies.length; bodyIndex++) {
      const body = bodies[bodyIndex];
      const frame = loadFrame(body);
      const locals = reportLocals(bodyIndex, body);
      const inserts = points
        .filter(p => p.address >= body.code && p.address < body.end)
        .map(p => ({
          at: p.address,
          bytes: [
            ...locals,
            OP_I32_CONST, ...sleb(byAddress.get(p.address)), ...frame, OP_CALL, ...uleb(hook),
          ],
        }));

      if (!inserts.length) {
        newBodies.push(binary.subarray(body.start, body.end));
        continue;
      }

      const out = [];
      let cursor = body.start;
      for (const insert of inserts) {
        out.push(binary.subarray(cursor, insert.at));
        out.push(Uint8Array.from(insert.bytes));
        grown += insert.bytes.length;
        shifts.push({ at: insert.at, delta: grown });
        cursor = insert.at;
      }
      out.push(binary.subarray(cursor, body.end));
      newBodies.push(concat(out));
    }

    const codeBody = [Uint8Array.from(uleb(bodies.length))];
    for (const body of newBodies) {
      codeBody.push(Uint8Array.from(uleb(body.length)));
      codeBody.push(body);
    }
    const codeBytes = concat(codeBody);

    // Reassemble: every section but code is copied verbatim.
    const out = [binary.subarray(0, 8)];
    for (const section of found) {
      const header = sectionHeaderStart(binary, section);
      if (section.id === SECTION_CODE) {
        out.push(Uint8Array.from([SECTION_CODE]));
        out.push(Uint8Array.from(uleb(codeBytes.length)));
        out.push(codeBytes);
      } else {
        out.push(binary.subarray(header, section.end));
      }
    }

    return {
      binary: concat(out),
      points,
      instrumented: points.length,
      remap: makeRemap(shifts, code, codeBytes.length, binary),
    };
  }

  function sectionHeaderStart(binary, section) {
    // Walk back over the size LEB and the id byte to find where the section
    // header began; sections() only recorded where the body starts.
    let pos = section.start - 1;
    while (pos > 0 && (binary[pos - 1] & 0x80) !== 0) pos--;
    return pos - 1;
  }

  // Maps a PC in the rewritten module back to the original module, so DWARF
  // lookups keep working. Anything before the code section is unmoved.
  function makeRemap(shifts, code, newCodeLength, binary) {
    const headerDelta = uleb(newCodeLength).length - uleb(code.end - code.start).length;
    return function remap(pc) {
      if (pc < code.start) return pc;
      let adjusted = pc - headerDelta;
      // Undo the insertions at or before this point, largest first.
      for (let i = shifts.length - 1; i >= 0; i--) {
        if (adjusted - shifts[i].delta >= shifts[i].at) return adjusted - shifts[i].delta;
      }
      return adjusted;
    };
  }

  function concat(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  /* Body ranges of the linked module, as ground truth for where each function
   * really starts and ends. DW_AT_high_pc has been seen to understate a
   * function badly, and a wrong end silently loses every local in it. */
  function bodies(binary) {
    const found = sections(binary);
    const code = found.find(s => s.id === SECTION_CODE);
    return code ? functionBodies(binary, code) : [];
  }

  global.DbgRewrite = { instrument, bodies };
})(typeof self !== 'undefined' ? self : this);
