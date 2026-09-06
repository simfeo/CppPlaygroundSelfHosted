/*
 * DWARF .debug_info reader: functions, their variables, and the types of those
 * variables.
 *
 * debuginfo.js reads the line table, which is enough to say where a crash
 * happened. Showing the value of a variable needs the other half of DWARF: the
 * DIE tree, which says a name lives at some offset from the frame base and has
 * a type of some shape.
 *
 * Debug builds are compiled -gdwarf-4 on purpose. DWARF 5 routes strings and
 * addresses through .debug_str_offsets and .debug_addr, which buys nothing here
 * and costs two more sections and an indirection on every attribute.
 */
(function (global) {
  'use strict';

  const utf8 = (bytes) => new TextDecoder('utf-8').decode(bytes);

  const TAG = {
    array_type: 0x01, class_type: 0x02, enumeration_type: 0x04, formal_parameter: 0x05,
    lexical_block: 0x0b, member: 0x0d, pointer_type: 0x0f, reference_type: 0x10,
    compile_unit: 0x11, structure_type: 0x13, subroutine_type: 0x15, typedef: 0x16,
    union_type: 0x17, unspecified_parameters: 0x18, inlined_subroutine: 0x1d,
    inheritance: 0x1c,
    subrange_type: 0x21, base_type: 0x24, const_type: 0x26, enumerator: 0x28,
    subprogram: 0x2e, variable: 0x34, volatile_type: 0x35, restrict_type: 0x37,
    rvalue_reference_type: 0x42,
  };

  const AT = {
    sibling: 0x01, location: 0x02, name: 0x03, byte_size: 0x0b, stmt_list: 0x10,
    low_pc: 0x11, high_pc: 0x12, language: 0x13, comp_dir: 0x1b, const_value: 0x1c,
    upper_bound: 0x2f, count: 0x37, data_member_location: 0x38, decl_file: 0x3a,
    decl_line: 0x3b, declaration: 0x3c, encoding: 0x3e, external: 0x3f,
    frame_base: 0x40, specification: 0x47, type: 0x49, ranges: 0x55,
    linkage_name: 0x6e,
  };

  // DW_ATE_*
  const ENC = {
    address: 0x01, boolean: 0x02, float: 0x04, signed: 0x05, signed_char: 0x06,
    unsigned: 0x07, unsigned_char: 0x08, utf: 0x10,
  };

  class Cursor {
    constructor(bytes, pos, end) {
      this.b = bytes;
      this.pos = pos || 0;
      this.end = end === undefined ? bytes.length : end;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    get eof() { return this.pos >= this.end; }
    u8() { return this.b[this.pos++]; }
    i8() { const v = this.view.getInt8(this.pos); this.pos += 1; return v; }
    u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
    u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
    skip(n) { this.pos += n; }
    bytes(n) { const v = this.b.subarray(this.pos, this.pos + n); this.pos += n; return v; }
    uleb() {
      let result = 0, shift = 1, byte;
      do { byte = this.b[this.pos++]; result += (byte & 0x7f) * shift; shift *= 128; } while (byte & 0x80);
      return result;
    }
    sleb() {
      let result = 0, shift = 1, byte;
      do { byte = this.b[this.pos++]; result += (byte & 0x7f) * shift; shift *= 128; } while (byte & 0x80);
      if (byte & 0x40) result -= shift;
      return result;
    }
    cstr() {
      const start = this.pos;
      while (this.pos < this.end && this.b[this.pos] !== 0) this.pos++;
      const s = utf8(this.b.subarray(start, this.pos));
      this.pos++;
      return s;
    }
  }

  function parseAbbrev(section, offset) {
    const table = new Map();
    if (!section) return table;
    const c = new Cursor(section, offset);
    for (;;) {
      const code = c.uleb();
      if (code === 0) break;
      const tag = c.uleb();
      const hasChildren = c.u8() !== 0;
      const attrs = [];
      for (;;) {
        const at = c.uleb();
        const form = c.uleb();
        const implicit = form === 0x21 ? c.sleb() : undefined;   // DW_FORM_implicit_const
        if (at === 0 && form === 0) break;
        attrs.push({ at, form, implicit });
      }
      table.set(code, { tag, hasChildren, attrs });
    }
    return table;
  }

  function stringAt(section, offset) {
    if (!section || offset >= section.length) return null;
    return new Cursor(section, offset).cstr();
  }

  function readForm(c, form, ctx, implicit) {
    switch (form) {
      case 0x01: return c.u32();                                  // addr (wasm32)
      case 0x03: return c.bytes(c.u16());                         // block2
      case 0x04: return c.bytes(c.u32());                         // block4
      case 0x05: return c.u16();                                  // data2
      case 0x06: return c.u32();                                  // data4
      case 0x07: { const lo = c.u32(), hi = c.u32(); return hi * 4294967296 + lo; }
      case 0x08: return c.cstr();                                 // string
      case 0x09: return c.bytes(c.uleb());                        // block
      case 0x0a: return c.bytes(c.u8());                          // block1
      case 0x0b: return c.u8();                                   // data1
      case 0x0c: return c.u8();                                   // flag
      case 0x0d: return c.sleb();                                 // sdata
      case 0x0e: return stringAt(ctx.str, c.u32());               // strp
      case 0x0f: return c.uleb();                                 // udata
      case 0x10: return c.u32();                                  // ref_addr
      case 0x11: return ctx.unitStart + c.u8();                   // ref1
      case 0x12: return ctx.unitStart + c.u16();                  // ref2
      case 0x13: return ctx.unitStart + c.u32();                  // ref4
      case 0x14: { const lo = c.u32(); c.u32(); return ctx.unitStart + lo; }
      case 0x15: return ctx.unitStart + c.uleb();                 // ref_udata
      case 0x16: return readForm(c, c.uleb(), ctx);               // indirect
      case 0x17: return c.u32();                                  // sec_offset
      case 0x18: return c.bytes(c.uleb());                        // exprloc
      case 0x19: return true;                                     // flag_present
      case 0x1a: return c.uleb();                                 // strx
      case 0x1e: c.skip(16); return null;                         // data16
      case 0x1f: return stringAt(ctx.lineStr, c.u32());           // line_strp
      case 0x20: c.skip(8); return null;                          // ref_sig8
      case 0x21: return implicit;                                 // implicit_const
      case 0x25: return c.u8();
      case 0x26: return c.u16();
      case 0x27: { const v = c.u16() + (c.u8() << 16); return v; }
      case 0x28: return c.u32();
      default: throw new Error('unsupported DW_FORM 0x' + form.toString(16));
    }
  }

  /*
   * Walks every compilation unit and keeps the DIEs by their section offset, so
   * a DW_AT_type reference is a map lookup. Only the tags the debugger can act
   * on are retained; the rest of the tree is walked but dropped.
   */
  function parse(custom, bias) {
    const info = custom.get('.debug_info');
    const abbrevSection = custom.get('.debug_abbrev');
    if (!info || !abbrevSection) return null;

    const ctx = { str: custom.get('.debug_str'), lineStr: custom.get('.debug_line_str'), unitStart: 0 };
    const dies = new Map();
    const functions = [];

    const c = new Cursor(info);
    while (c.pos + 11 < c.end) {
      const unitStart = c.pos;
      const unitLength = c.u32();
      if (unitLength === 0 || unitLength >= 0xfffffff0) break;
      const unitEnd = c.pos + unitLength;
      const version = c.u16();

      let abbrevOffset;
      if (version >= 5) {
        c.u8();                       // unit_type
        c.u8();                       // address_size
        abbrevOffset = c.u32();
      } else {
        abbrevOffset = c.u32();
        c.u8();                       // address_size
      }
      const abbrevs = parseAbbrev(abbrevSection, abbrevOffset);
      ctx.unitStart = unitStart;

      const stack = [];
      while (c.pos < unitEnd) {
        const offset = c.pos;
        const code = c.uleb();
        if (code === 0) { stack.pop(); continue; }
        const abbrev = abbrevs.get(code);
        if (!abbrev) break;           // desynced; abandon this unit

        const die = { tag: abbrev.tag, offset, attrs: {}, children: [] };
        for (const spec of abbrev.attrs) {
          const value = readForm(c, spec.form, ctx, spec.implicit);
          die.attrs[spec.at] = value;
        }

        const parent = stack[stack.length - 1];
        if (parent) parent.children.push(die);
        dies.set(offset, die);
        if (die.tag === TAG.subprogram && die.attrs[AT.low_pc] !== undefined) functions.push(die);
        if (abbrev.hasChildren) stack.push(die);
      }
      c.pos = unitEnd;
    }

    return makeIndex(dies, functions, bias || 0);
  }

  function makeIndex(dies, functions, bias) {
    // high_pc is an offset from low_pc whenever it came through a data form,
    // and an address when it came through DW_FORM_addr. Sizes are small, so a
    // value below low_pc can only be the offset spelling.
    // .debug_info addresses are relative to the start of the code section, the
    // same as the line table's before debuginfo.js lifts them to module
    // offsets. Both have to end up in one space or nothing lines up.
    for (const fn of functions) {
      const low = fn.attrs[AT.low_pc] || 0;
      let high = fn.attrs[AT.high_pc] || 0;
      if (high < low) high = low + high;
      fn.range = { low: low + bias, high: high + bias };
    }
    functions.sort((a, b) => a.range.low - b.range.low);

    function typeOf(die) {
      const ref = die.attrs[AT.type];
      return ref === undefined ? null : dies.get(ref) || null;
    }

    function nameOf(die) {
      return die && die.attrs[AT.name] ? String(die.attrs[AT.name]) : null;
    }

    /* Peels typedefs and cv-qualifiers to whatever actually has a layout. */
    function stripped(die) {
      let t = die;
      while (t && (t.tag === TAG.typedef || t.tag === TAG.const_type ||
                   t.tag === TAG.volatile_type || t.tag === TAG.restrict_type)) {
        t = typeOf(t);
      }
      return t;
    }

    function sizeOf(die) {
      const t = stripped(die);
      if (!t) return 0;
      if (t.attrs[AT.byte_size] !== undefined) return t.attrs[AT.byte_size];
      if (t.tag === TAG.pointer_type || t.tag === TAG.reference_type ||
          t.tag === TAG.rvalue_reference_type) return 4;
      if (t.tag === TAG.array_type) {
        const element = sizeOf(typeOf(t));
        return element * (arrayCount(t) || 0);
      }
      return 0;
    }

    function arrayCount(die) {
      for (const child of die.children) {
        if (child.tag !== TAG.subrange_type) continue;
        if (child.attrs[AT.count] !== undefined) return child.attrs[AT.count];
        if (child.attrs[AT.upper_bound] !== undefined) return child.attrs[AT.upper_bound] + 1;
      }
      return 0;
    }

    /* Splits template arguments at the top level only, so the comma inside
     * map<int, vector<int>> does not count as a separator. */
    function splitArgs(text) {
      const args = [];
      let depth = 0, start = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '<' || c === '(') depth++;
        else if (c === '>' || c === ')') depth--;
        else if (c === ',' && depth === 0) { args.push(text.slice(start, i)); start = i + 1; }
      }
      args.push(text.slice(start));
      return args.map(a => a.trim()).filter(a => a.length);
    }

    // Arguments the programmer never wrote and does not want to read back.
    const DEFAULTED = /^std::(allocator|char_traits|default_delete|less|hash|equal_to)</;

    /*
     * DWARF spells a type in full: vector<int> arrives as
     * vector<int, std::__2::allocator<int> >, and a string is four lines wide.
     * This puts it back into the form it was written in, which is the whole
     * point of the type column.
     */
    function simplify(name) {
      const open = name.indexOf('<');
      if (open < 0 || name[name.length - 1] !== '>') return name;
      const base = name.slice(0, open);
      let args = splitArgs(name.slice(open + 1, -1)).map(simplify);
      while (args.length > 1 && DEFAULTED.test(args[args.length - 1])) args.pop();
      // The name arrives unqualified at the top level and qualified inside a
      // template argument, so the namespace is stripped before matching.
      const bare = base.slice(base.lastIndexOf(':') + 1);
      if (args.length === 1 && args[0] === 'char') {
        if (bare === 'basic_string') return 'std::string';
        if (bare === 'basic_string_view') return 'std::string_view';
      }
      const inner = args.join(', ');
      return base + '<' + inner + (inner[inner.length - 1] === '>' ? ' >' : '>');
    }

    function pretty(name) {
      return simplify(name.split('std::__2::').join('std::'));
    }

    /* A readable spelling of a type, close to how it was written. */
    function typeName(die) {
      if (!die) return 'void';
      switch (die.tag) {
        case TAG.pointer_type: return typeName(typeOf(die)) + '*';
        case TAG.reference_type: return typeName(typeOf(die)) + '&';
        case TAG.rvalue_reference_type: return typeName(typeOf(die)) + '&&';
        case TAG.const_type: return typeName(typeOf(die)) + ' const';
        case TAG.volatile_type: return typeName(typeOf(die)) + ' volatile';
        case TAG.restrict_type: return typeName(typeOf(die));
        case TAG.array_type: {
          const n = arrayCount(die);
          return typeName(typeOf(die)) + '[' + (n || '') + ']';
        }
        default: {
          const name = nameOf(die);
          if (name) return pretty(name);
          if (die.tag === TAG.structure_type || die.tag === TAG.class_type) return '(anonymous struct)';
          if (die.tag === TAG.union_type) return '(anonymous union)';
          return '?';
        }
      }
    }

    /* Replaces each function's DWARF range with the wasm function body that
     * contains its start. The binary is authoritative about where code begins
     * and ends; DW_AT_high_pc is not always. */
    function snapTo(bodies) {
      for (const fn of functions) {
        // low_pc lands on the body, which begins with the locals vector, so the
        // match is against the body's start rather than its first instruction.
        const body = bodies.find(b => fn.range.low >= b.start && fn.range.low < b.end);
        if (body) fn.range = { low: body.start, high: body.end };
      }
      functions.sort((a, b) => a.range.low - b.range.low);
    }

    function functionAt(pc) {
      let lo = 0, hi = functions.length - 1, found = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (functions[mid].range.low <= pc) { found = functions[mid]; lo = mid + 1; } else hi = mid - 1;
      }
      return found && pc < found.range.high ? found : null;
    }

    /* Parameters first, then locals, walking into lexical blocks that contain
     * the pc so an out-of-scope name is not offered. */
    function localsOf(fn, pc) {
      const out = [];
      const walk = (die) => {
        for (const child of die.children) {
          if (child.tag === TAG.formal_parameter || child.tag === TAG.variable) {
            if (child.attrs[AT.name] && child.attrs[AT.location] !== undefined) {
              out.push({
                name: String(child.attrs[AT.name]),
                die: child,
                type: typeOf(child),
                location: child.attrs[AT.location],
                isParam: child.tag === TAG.formal_parameter,
              });
            }
          } else if (child.tag === TAG.lexical_block) {
            const rawLow = child.attrs[AT.low_pc];
            let rawHigh = child.attrs[AT.high_pc];
            if (rawLow === undefined) { walk(child); continue; }
            if (rawHigh !== undefined && rawHigh < rawLow) rawHigh = rawLow + rawHigh;
            const low = rawLow + bias;
            const high = rawHigh + bias;
            if (pc === undefined || (pc >= low && pc < high)) walk(child);
          }
        }
      };
      walk(fn);
      return out;
    }

    /*
     * DW_AT_frame_base on wasm is DW_OP_WASM_location: a wasm local or global,
     * not an address. A host cannot read either out of a live frame, so the
     * answer here is what dbgrewrite.js compiles into the call that fetches it.
     *
     *   0xED 0x00 <uleb local>    a local        (what -O0 uses for a frame pointer)
     *   0xED 0x01 <uleb global>   a global
     *   0xED 0x03 <u32 global>    a global, fixed width
     * usually followed by 0x9F, DW_OP_stack_value.
     */
    function frameBaseOf(fn) {
      const expr = fn && fn.attrs[AT.frame_base];
      if (!expr || expr.length < 3 || expr[0] !== 0xED) return null;
      const c = new Cursor(expr, 1);
      const kind = c.u8();
      if (kind === 0x00) return { kind: 'local', index: c.uleb() };
      if (kind === 0x01) return { kind: 'global', index: c.uleb() };
      if (kind === 0x03) return { kind: 'global', index: c.u32() };
      return null;
    }

    function frameBaseAt(pc) {
      return frameBaseOf(functionAt(pc));
    }

    /* DW_OP_fbreg <sleb> is the only location the debugger acts on: at -O0 it
     * is what every parameter and local gets. Anything else reads as unknown
     * rather than guessing at an address. */
    /* An expression that ends in DW_OP_stack_value yields the value itself;
     * without it the result is the address the object lives at. A by-value
     * struct parameter comes through as DW_OP_WASM_location <local> and no
     * stack_value, so that local holds a pointer, and the program reports it
     * through __dbg_local. */
    function wasmLocalOf(location) {
      if (!location || location.length < 3 || location[0] !== 0xED) return null;
      if (location[location.length - 1] === 0x9F) return null;   // a value, not an address
      const c = new Cursor(location, 1);
      if (c.u8() !== 0x00) return null;                          // only locals are reported
      return c.uleb();
    }

    /* Every wasm local this function's variables are addressed through. */
    function wasmLocalsOf(fn) {
      const slots = new Set();
      if (!fn) return [];
      for (const variable of localsOf(fn)) {
        const slot = wasmLocalOf(variable.location);
        if (slot !== null) slots.add(slot);
      }
      return [...slots];
    }

    function wasmLocalsAt(pc) {
      return wasmLocalsOf(functionAt(pc));
    }

    function addressOf(location, framePointer, localValues) {
      if (!location || !location.length) return null;
      if (location[0] === 0x91) {                                // DW_OP_fbreg
        const offset = new Cursor(location, 1).sleb();
        return (framePointer + offset) >>> 0;
      }
      const slot = wasmLocalOf(location);
      if (slot !== null && localValues && localValues[slot] !== undefined) {
        return localValues[slot] >>> 0;
      }
      return null;
    }

    /* Why a variable has no address, when it has none. A value living in a
     * wasm local is not a gap in this reader: locals belong to the engine, and
     * nothing outside the module can read another frame's. */
    function whyNoAddress(location) {
      if (!location || !location.length) return 'no location';
      if (location[0] !== 0xED) return 'unsupported location';
      // With DW_OP_stack_value the local *is* the value, and a wasm local is
      // not something a host can read. Without it the local holds an address,
      // which the program reports, so landing here means it never ran the
      // reporting call for this one - an i64 or float local, say.
      return location[location.length - 1] === 0x9F
        ? 'value is in a wasm local'
        : 'address not reported';
    }

    return {
      dies, functions,
      functionAt, localsOf, typeOf, typeName, nameOf, stripped, sizeOf, arrayCount,
      frameBaseOf, frameBaseAt, addressOf, whyNoAddress, snapTo,
      wasmLocalOf, wasmLocalsOf, wasmLocalsAt,
      count: functions.length,
    };
  }

  /* ---------- reading values out of the program's memory ---------- */

  function makeMemory(buffer) {
    const bytes = new Uint8Array(buffer);
    // A copy, because a threaded program's memory is shared and DataView on it
    // is fine but TextDecoder over it is not.
    const view = new DataView(buffer);
    const ok = (at, n) => at >= 0 && at + n <= bytes.length;
    return {
      length: bytes.length,
      u8: (at) => (ok(at, 1) ? view.getUint8(at) : null),
      i8: (at) => (ok(at, 1) ? view.getInt8(at) : null),
      u16: (at) => (ok(at, 2) ? view.getUint16(at, true) : null),
      i16: (at) => (ok(at, 2) ? view.getInt16(at, true) : null),
      u32: (at) => (ok(at, 4) ? view.getUint32(at, true) : null),
      i32: (at) => (ok(at, 4) ? view.getInt32(at, true) : null),
      u64: (at) => (ok(at, 8) ? view.getBigUint64(at, true) : null),
      i64: (at) => (ok(at, 8) ? view.getBigInt64(at, true) : null),
      f32: (at) => (ok(at, 4) ? view.getFloat32(at, true) : null),
      f64: (at) => (ok(at, 8) ? view.getFloat64(at, true) : null),
      cstring(at, limit) {
        if (!ok(at, 1)) return null;
        const max = Math.min(bytes.length, at + (limit || 200));
        let end = at;
        while (end < max && bytes[end] !== 0) end++;
        return utf8(new Uint8Array(bytes.subarray(at, end)));
      },
    };
  }

  function integer(mem, address, size, signed) {
    if (size === 1) return signed ? mem.i8(address) : mem.u8(address);
    if (size === 2) return signed ? mem.i16(address) : mem.u16(address);
    if (size === 8) {
      const v = signed ? mem.i64(address) : mem.u64(address);
      return v === null ? null : v.toString();
    }
    return signed ? mem.i32(address) : mem.u32(address);
  }

  function printable(code) {
    if (code === null) return '?';
    if (code === 0) return "'\\0'";
    if (code >= 32 && code < 127) return "'" + String.fromCharCode(code) + "'";
    return code;
  }

  const MAX_ELEMENTS = 24;
  const PREVIEW_ITEMS = 6;
  const PREVIEW_CHARS = 60;

  /* A one-line summary, so a struct or array says something without being
   * opened. The full contents are still there as children. */
  function preview(children, total, named) {
    if (!children.length) return '{}';
    const parts = [];
    for (const child of children.slice(0, PREVIEW_ITEMS)) {
      if (child.name === '...') continue;
      parts.push(named ? `${child.name} = ${child.value}` : child.value);
    }
    let text = parts.join(', ');
    if (text.length > PREVIEW_CHARS) text = text.slice(0, PREVIEW_CHARS) + '...';
    else if (total > parts.length) text += ', ...';
    return '{' + text + '}';
  }

  /*
   * Finds a member by name and returns its offset within the outer object.
   * Recurses through base classes and through anonymous members, because the
   * pieces of a libc++ container are rarely where a formatter would write them:
   * optional keeps __engaged_ in a base and __val_ inside an unnamed union.
   */
  function member(dw, type, name, depth) {
    const t = dw.stripped(type);
    const level = depth || 0;
    // The chain is deeper than it looks: libc++ reaches __optional_destruct_base,
    // where the value actually lives, through six layers of base class.
    if (!t || !t.children || level > 8) return null;
    for (const child of t.children) {
      const at = child.attrs[AT.data_member_location];
      if (child.tag === TAG.member) {
        const own = dw.nameOf(child);
        if (typeof at !== 'number') continue;
        if (own === name) return { die: child, type: dw.typeOf(child), offset: at };
        if (own === null) {
          const nested = member(dw, dw.typeOf(child), name, level + 1);
          if (nested) return { die: nested.die, type: nested.type, offset: at + nested.offset };
        }
      } else if (child.tag === TAG.inheritance && typeof at === 'number') {
        const base = member(dw, dw.typeOf(child), name, level + 1);
        if (base) return { die: base.die, type: base.type, offset: at + base.offset };
      }
    }
    return null;
  }

  function memberAny(dw, type, names) {
    for (const name of names) {
      const found = member(dw, type, name);
      if (found) return found;
    }
    return null;
  }

  /* The template name without its arguments, which is what a formatter is
   * keyed on: every std::vector<T> is served by the same one. */
  function templateName(name) {
    if (!name) return null;
    const cut = name.indexOf('<');
    return cut < 0 ? name : name.slice(0, cut);
  }

  function pointee(dw, type) {
    const t = dw.stripped(type);
    if (!t || t.tag !== TAG.pointer_type) return null;
    return dw.typeOf(t);
  }

  function escape(text) {
    return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
               .replace(/\t/g, '\\t').replace(/\r/g, '\\r');
  }

  /*
   * Renderers for the standard library types, in the spirit of gdb's
   * pretty-printers: without them a string is a union of bitfields and a vector
   * is three pointers. Everything is located by DWARF member name rather than
   * by hard-coded offsets, so a libc++ update that moves a field does not
   * silently produce wrong values. Any formatter may return null, and the plain
   * member-by-member rendering takes over - which is also what happens for a
   * half-constructed object, where the raw fields are the more honest answer.
   */
  const FORMATTERS = {
    basic_string(ctx) {
      const { dw, t, address, mem } = ctx;
      const rep = memberAny(dw, t, ['__rep_', '__r_']);
      if (!rep) return null;
      // __rep is a union of __l (heap) and __s (inline), and the layout is only
      // decodable for a byte-sized character: the short form packs its size and
      // the long/short flag into bitfields this reader does not decode, so both
      // are taken from the raw last byte instead.
      const long_ = member(dw, rep.type, '__l');
      const short_ = member(dw, rep.type, '__s');
      if (!long_ || !short_) return null;
      const data = member(dw, long_.type, '__data_');
      const size = member(dw, long_.type, '__size_');
      const inline_ = member(dw, short_.type, '__data_');
      if (!data || !size || !inline_) return null;
      const chars = dw.stripped(pointee(dw, data.type));
      if (!chars || dw.sizeOf(chars) !== 1) return null;

      const width = dw.sizeOf(rep.type) || dw.sizeOf(t);
      if (!width) return null;
      const flags = mem.u8(address + rep.offset + width - 1);
      if (flags === null) return null;

      let at, count, capacity;
      if (flags & 0x80) {
        at = mem.u32(address + rep.offset + long_.offset + data.offset);
        count = mem.u32(address + rep.offset + long_.offset + size.offset);
        const cap = mem.u32(address + rep.offset + long_.offset + size.offset + 4);
        capacity = cap === null ? null : (cap & 0x7fffffff);
      } else {
        at = address + rep.offset + short_.offset + inline_.offset;
        count = flags & 0x7f;
        capacity = width - 1;
      }
      if (at === null || count === null || count > mem.length) return null;

      const text = mem.cstring(at, Math.min(count, 400) + 1);
      if (text === null) return null;
      const shown = count > 400 ? text + '...' : text;
      const children = [
        { name: '[size]', type: '', value: String(count) },
        { name: '[capacity]', type: '', value: capacity === null ? '?' : String(capacity) },
      ];
      return { value: '"' + escape(shown) + '"', children };
    },

    basic_string_view(ctx) {
      const { dw, t, address, mem } = ctx;
      const data = member(dw, t, '__data_');
      const size = member(dw, t, '__size_');
      if (!data || !size) return null;
      const chars = dw.stripped(pointee(dw, data.type));
      if (!chars || dw.sizeOf(chars) !== 1) return null;
      const at = mem.u32(address + data.offset);
      const count = mem.u32(address + size.offset);
      if (at === null || count === null || count > mem.length) return null;
      if (!at) return { value: count ? '<bad>' : '""' };
      const text = mem.cstring(at, Math.min(count, 400) + 1);
      if (text === null) return null;
      return {
        value: '"' + escape(count > 400 ? text + '...' : text) + '"',
        children: [{ name: '[size]', type: '', value: String(count) }],
      };
    },

    vector(ctx) {
      const { dw, t, address, mem, read, level } = ctx;
      const begin = member(dw, t, '__begin_');
      const end = member(dw, t, '__end_');
      if (!begin || !end) return null;
      const element = pointee(dw, begin.type);
      const stride = dw.sizeOf(element);
      if (!element || !stride) return null;   // vector<bool> has no element pointer

      const first = mem.u32(address + begin.offset);
      const last = mem.u32(address + end.offset);
      if (first === null || last === null || last < first) return null;
      const count = (last - first) / stride;
      if (!Number.isInteger(count) || count < 0 || count > mem.length) return null;

      const children = [];
      for (let i = 0; i < Math.min(count, MAX_ELEMENTS); i++) {
        const item = read(element, first + i * stride, level + 1);
        children.push({ name: `[${i}]`, type: dw.typeName(element), value: item.value, children: item.children });
      }
      if (count > MAX_ELEMENTS) children.push({ name: '...', type: '', value: `${count - MAX_ELEMENTS} more` });
      // Summarised before the size and capacity rows join it, so they do not
      // read as two more elements of the vector.
      const value = count ? preview(children, count) : '{}';
      const cap = memberAny(dw, t, ['__cap_', '__end_cap_']);
      const capEnd = cap ? mem.u32(address + cap.offset) : null;
      children.push({ name: '[size]', type: '', value: String(count) });
      if (capEnd !== null && capEnd >= first) {
        children.push({ name: '[capacity]', type: '', value: String((capEnd - first) / stride) });
      }
      return { value, children };
    },

    array(ctx) {
      const { dw, t, address, read, level } = ctx;
      const elems = member(dw, t, '__elems_');
      if (!elems) return null;
      return read(elems.type, address + elems.offset, level);
    },

    unique_ptr(ctx) {
      const { dw, t, address, mem, read, level } = ctx;
      const ptr = member(dw, t, '__ptr_');
      if (!ptr) return null;
      const target = mem.u32(address + ptr.offset);
      if (target === null) return null;
      if (!target) return { value: 'nullptr' };
      const held = pointee(dw, ptr.type);
      const hex = '0x' + target.toString(16);
      if (!held || level >= 2) return { value: hex };
      const inner = read(held, target, level + 1);
      return { value: `${hex} -> ${inner.value}`, children: [{ name: '*', type: dw.typeName(held), value: inner.value, children: inner.children }] };
    },

    shared_ptr(ctx) {
      const { dw, t, address, mem, read, level } = ctx;
      const ptr = member(dw, t, '__ptr_');
      if (!ptr) return null;
      const target = mem.u32(address + ptr.offset);
      if (target === null) return null;
      if (!target) return { value: 'nullptr' };
      const held = pointee(dw, ptr.type);
      const hex = '0x' + target.toString(16);
      const children = [];
      let shown = hex;
      if (held && level < 2) {
        const inner = read(held, target, level + 1);
        shown = `${hex} -> ${inner.value}`;
        // libc++ reaches the pointee through an element_type typedef, whose name
        // says nothing; the type behind it is what the reader wants.
        const named = dw.nameOf(held) === 'element_type' ? dw.stripped(held) : held;
        children.push({ name: '*', type: dw.typeName(named), value: inner.value, children: inner.children });
      }
      // The control block's shared count is one less than use_count(), and its
      // type is usually absent from the user's debug info, so the field is read
      // at its fixed place past the vtable pointer rather than looked up.
      const cntrl = member(dw, t, '__cntrl_');
      if (cntrl) {
        const block = mem.u32(address + cntrl.offset);
        const owners = block ? mem.u32(block + 4) : null;
        if (owners !== null && owners < 0x1000000) {
          children.push({ name: '[use_count]', type: '', value: String(owners + 1) });
        }
      }
      return { value: shown, children };
    },

    optional(ctx) {
      const { dw, t, address, mem, read, level } = ctx;
      const engaged = member(dw, t, '__engaged_');
      const value = member(dw, t, '__val_');
      if (!engaged || !value) return null;
      const on = mem.u8(address + engaged.offset);
      if (on === null) return null;
      if (!on) return { value: 'nullopt' };
      const inner = read(value.type, address + value.offset, level);
      return { value: inner.value, children: inner.children };
    },
  };

  FORMATTERS.__shared_ptr = FORMATTERS.shared_ptr;

  /* The data members of a class, with those it inherits folded in at their own
   * offsets. Without the base walk a derived object shows as {}, since the
   * fields it displays are all one level down. */
  function fields(dw, t, address, mem, level, depth) {
    const rows = [];
    if (depth > 8) return rows;
    for (const child of t.children) {
      const at = child.attrs[AT.data_member_location];
      if (typeof at !== 'number') continue;
      if (child.tag === TAG.inheritance) {
        const base = dw.stripped(dw.typeOf(child));
        if (base && base.children) rows.push(...fields(dw, base, address + at, mem, level, depth + 1));
        continue;
      }
      if (child.tag !== TAG.member) continue;
      const name = dw.nameOf(child);
      if (name === null) continue;
      const memberType = dw.typeOf(child);
      const item = readValue(dw, memberType, address + at, mem, level + 1);
      rows.push({ name, type: dw.typeName(memberType), value: item.value, children: item.children });
    }
    return rows;
  }

  /*
   * Renders one variable as {value, children}. Depth is bounded because a type
   * can refer to itself: a linked list node would otherwise recurse forever.
   */
  function readValue(dw, type, address, mem, depth) {
    const level = depth === undefined ? 0 : depth;
    const t = dw.stripped(type);
    if (address === null || address === undefined) return { value: '<no location>' };
    if (!t) return { value: '<void>' };

    switch (t.tag) {
      case TAG.base_type: {
        const size = t.attrs[AT.byte_size] || 4;
        const enc = t.attrs[AT.encoding];
        if (enc === ENC.float) {
          const v = size === 4 ? mem.f32(address) : mem.f64(address);
          return { value: v === null ? '<unreadable>' : String(v) };
        }
        if (enc === ENC.boolean) {
          const v = mem.u8(address);
          return { value: v === null ? '<unreadable>' : (v ? 'true' : 'false') };
        }
        if (enc === ENC.signed_char || enc === ENC.unsigned_char) {
          const v = enc === ENC.signed_char ? mem.i8(address) : mem.u8(address);
          return { value: v === null ? '<unreadable>' : `${v} ${printable(v & 0xff)}` };
        }
        const signed = enc === ENC.signed;
        const v = integer(mem, address, size, signed);
        return { value: v === null ? '<unreadable>' : String(v) };
      }

      case TAG.enumeration_type: {
        const size = t.attrs[AT.byte_size] || 4;
        const v = integer(mem, address, size, true);
        for (const child of t.children) {
          if (child.tag === TAG.enumerator && child.attrs[AT.const_value] === v) {
            return { value: `${dw.nameOf(child)} (${v})` };
          }
        }
        return { value: v === null ? '<unreadable>' : String(v) };
      }

      case TAG.pointer_type:
      case TAG.reference_type:
      case TAG.rvalue_reference_type: {
        const target = mem.u32(address);
        if (target === null) return { value: '<unreadable>' };
        const pointee = dw.stripped(dw.typeOf(t));
        const hex = '0x' + target.toString(16);
        if (target && pointee && pointee.tag === TAG.base_type &&
            (pointee.attrs[AT.encoding] === ENC.signed_char ||
             pointee.attrs[AT.encoding] === ENC.unsigned_char)) {
          const text = mem.cstring(target);
          return { value: text === null ? hex : `${hex} "${text}"` };
        }
        if (!target) return { value: 'nullptr' };
        if (level >= 2 || !pointee) return { value: hex };
        const inner = readValue(dw, pointee, target, mem, level + 1);
        return { value: hex, children: inner.children || [{ name: '*', type: dw.typeName(pointee), value: inner.value }] };
      }

      case TAG.array_type: {
        const element = dw.typeOf(t);
        const stride = dw.sizeOf(element) || 1;
        const count = dw.arrayCount(t);
        const bare = dw.stripped(element);
        if (bare && bare.tag === TAG.base_type &&
            (bare.attrs[AT.encoding] === ENC.signed_char || bare.attrs[AT.encoding] === ENC.unsigned_char)) {
          const text = mem.cstring(address, count || 200);
          return { value: text === null ? '<unreadable>' : `"${text}"` };
        }
        const children = [];
        for (let i = 0; i < Math.min(count, MAX_ELEMENTS); i++) {
          const item = readValue(dw, element, address + i * stride, mem, level + 1);
          children.push({ name: `[${i}]`, type: dw.typeName(element), value: item.value, children: item.children });
        }
        if (count > MAX_ELEMENTS) children.push({ name: '...', type: '', value: `${count - MAX_ELEMENTS} more` });
        return { value: preview(children, count), children };
      }

      case TAG.structure_type:
      case TAG.class_type:
      case TAG.union_type: {
        const formatter = level < 4 ? FORMATTERS[templateName(dw.nameOf(t))] : null;
        if (formatter) {
          const read = (type, at, depth) => readValue(dw, type, at, mem, depth);
          let shaped = null;
          try {
            shaped = formatter({ dw, t, address, mem, read, level });
          } catch (e) {
            shaped = null;   // a bad read is not worth losing the whole panel over
          }
          if (shaped) return shaped;
        }
        if (level >= 3) return { value: '{...}' };
        const children = fields(dw, t, address, mem, level, 0);
        return { value: preview(children, children.length, true), children };
      }

      default:
        return { value: '<' + dw.typeName(t) + '>' };
    }
  }

  global.DwarfInfo = { parse, makeMemory, readValue, TAG, AT, ENC };

})(typeof self !== 'undefined' ? self : this);
