/*
 * Symbolizer for the user's program: turns a wasm trap into a backtrace with
 * demangled names and source locations.
 *
 * Two inputs, both already inside the linked module:
 *   - the "name" custom section, which maps a function index to its link name;
 *     wasm-ld emits it unless told to strip, already demangled unless it was
 *     given --no-demangle;
 *   - .debug_line, the DWARF line-number program, emitted because we compile
 *     with -g. Only the line table is read - reading .debug_info would need
 *     .debug_abbrev and a full DIE walk for no gain here.
 *
 * V8 formats wasm frames as "wasm-function[<index>]:0x<offset>", where the
 * offset is a byte position inside the module. That is the same coordinate
 * space DWARF uses for wasm, which is what makes the join below possible.
 */
(function (global) {
  'use strict';

  const utf8 = (bytes) => new TextDecoder('utf-8').decode(bytes);

  /* ---------- byte cursor ---------- */

  class Cursor {
    constructor(bytes, pos, end) {
      this.b = bytes;
      this.pos = pos === undefined ? 0 : pos;
      this.end = end === undefined ? bytes.length : end;
      this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    get eof() { return this.pos >= this.end; }
    need(n) { if (this.pos + n > this.end) throw new RangeError('truncated'); }
    u8() { this.need(1); return this.b[this.pos++]; }
    i8() { this.need(1); return this.view.getInt8(this.pos++); }
    u16() { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
    u32() { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
    skip(n) { this.need(n); this.pos += n; }
    bytes(n) { this.need(n); const v = this.b.subarray(this.pos, this.pos + n); this.pos += n; return v; }
    // Multiplication rather than << : LEB values here can exceed 31 bits.
    uleb() {
      let result = 0, shift = 1, byte;
      do { byte = this.u8(); result += (byte & 0x7f) * shift; shift *= 128; } while (byte & 0x80);
      return result;
    }
    sleb() {
      let result = 0, shift = 1, byte;
      do { byte = this.u8(); result += (byte & 0x7f) * shift; shift *= 128; } while (byte & 0x80);
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

  /* ---------- wasm container ---------- */

  function readSections(binary) {
    const c = new Cursor(binary);
    if (c.u32() !== 0x6d736100) throw new Error('not a wasm module');
    c.u32();
    const custom = new Map();
    let code = null;
    while (!c.eof) {
      const id = c.u8();
      const size = c.uleb();
      const body = c.pos;
      if (id === 0) {
        const sub = new Cursor(binary, body, body + size);
        const name = utf8(sub.bytes(sub.uleb()));
        if (!custom.has(name)) custom.set(name, binary.subarray(sub.pos, body + size));
      } else if (id === 10) {
        code = { start: body, end: body + size };
      }
      c.pos = body + size;
    }
    return { custom, code };
  }

  function parseNameSection(section) {
    const names = new Map();
    const c = new Cursor(section);
    while (!c.eof) {
      const id = c.u8();
      const size = c.uleb();
      const end = c.pos + size;
      if (id === 1) {
        const sub = new Cursor(section, c.pos, end);
        const count = sub.uleb();
        for (let i = 0; i < count; i++) {
          const index = sub.uleb();
          names.set(index, utf8(sub.bytes(sub.uleb())));
        }
      }
      c.pos = end;
    }
    return names;
  }

  /* ---------- DWARF .debug_line ---------- */

  const DW_FORM = {
    addr: 0x01, block2: 0x03, block4: 0x04, data2: 0x05, data4: 0x06, data8: 0x07,
    string: 0x08, block: 0x09, block1: 0x0a, data1: 0x0b, flag: 0x0c, sdata: 0x0d,
    strp: 0x0e, udata: 0x0f, line_strp: 0x1f, data16: 0x1e,
    strx: 0x1a, strx1: 0x25, strx2: 0x26, strx3: 0x27, strx4: 0x28,
  };

  function stringAt(section, offset) {
    if (!section || offset >= section.length) return null;
    return new Cursor(section, offset).cstr();
  }

  function readForm(c, form, strs) {
    switch (form) {
      case DW_FORM.string: return c.cstr();
      case DW_FORM.strp: return stringAt(strs.str, c.u32());
      case DW_FORM.line_strp: return stringAt(strs.lineStr, c.u32());
      case DW_FORM.data1: case DW_FORM.flag: case DW_FORM.strx1: return c.u8();
      case DW_FORM.data2: case DW_FORM.strx2: return c.u16();
      case DW_FORM.data4: case DW_FORM.strx4: return c.u32();
      case DW_FORM.data8: c.skip(8); return null;
      case DW_FORM.data16: c.skip(16); return null;
      case DW_FORM.udata: case DW_FORM.strx: return c.uleb();
      case DW_FORM.sdata: return c.sleb();
      case DW_FORM.strx3: c.skip(3); return null;
      case DW_FORM.addr: c.skip(strs.addressSize); return null;
      case DW_FORM.block: c.skip(c.uleb()); return null;
      case DW_FORM.block1: c.skip(c.u8()); return null;
      case DW_FORM.block2: c.skip(c.u16()); return null;
      case DW_FORM.block4: c.skip(c.u32()); return null;
      default: throw new Error('unsupported DW_FORM 0x' + form.toString(16));
    }
  }

  function joinPath(dir, name) {
    if (!name) return name;
    if (!dir || name[0] === '/' || /^[A-Za-z]:/.test(name)) return name;
    return dir.replace(/\/+$/, '') + '/' + name;
  }

  function readFileTableV4(c) {
    const dirs = [''];
    for (;;) { const s = c.cstr(); if (!s) break; dirs.push(s); }
    const files = [null];   // DWARF <= 4 numbers files from 1
    for (;;) {
      const name = c.cstr();
      if (!name) break;
      const dir = c.uleb();
      c.uleb();
      c.uleb();
      files.push(joinPath(dirs[dir], name));
    }
    return files;
  }

  function readEntriesV5(c, strs) {
    const format = [];
    const formatCount = c.u8();
    for (let i = 0; i < formatCount; i++) format.push([c.uleb(), c.uleb()]);
    const count = c.uleb();
    const out = [];
    for (let i = 0; i < count; i++) {
      const entry = {};
      for (let f = 0; f < format.length; f++) {
        const value = readForm(c, format[f][1], strs);
        if (format[f][0] === 1) entry.path = value;
        else if (format[f][0] === 2) entry.dir = value;
      }
      out.push(entry);
    }
    return out;
  }

  function readFileTableV5(c, strs) {
    const dirs = readEntriesV5(c, strs).map(d => d.path || '');
    return readEntriesV5(c, strs).map(f => joinPath(dirs[f.dir || 0], f.path));
  }

  function runLineProgram(c, header, files, rows) {
    const { minInst, lineBase, lineRange, opcodeBase, stdLengths, addressSize } = header;
    let address = 0, file = 1, line = 1, column = 0;
    const reset = () => { address = 0; file = 1; line = 1; column = 0; };
    const emit = (end) => {
      rows.push({ address, line, column, end, path: files[file] || null });
    };

    while (!c.eof) {
      const op = c.u8();
      if (op >= opcodeBase) {
        const adjusted = op - opcodeBase;
        address += minInst * Math.floor(adjusted / lineRange);
        line += lineBase + (adjusted % lineRange);
        emit(false);
      } else if (op === 0) {
        const length = c.uleb();
        const next = c.pos + length;
        const sub = c.u8();
        if (sub === 1) { emit(true); reset(); }
        else if (sub === 2) {
          address = addressSize === 8 ? (c.u32() + c.u32() * 4294967296) : c.u32();
        }
        c.pos = next;
      } else {
        switch (op) {
          case 1: emit(false); break;
          case 2: address += minInst * c.uleb(); break;
          case 3: line += c.sleb(); break;
          case 4: file = c.uleb(); break;
          case 5: column = c.uleb(); break;
          case 6: case 7: break;
          case 8: address += minInst * Math.floor((255 - opcodeBase) / lineRange); break;
          case 9: address += c.u16(); break;
          case 10: case 11: break;
          case 12: c.uleb(); break;
          default:
            for (let i = 0; i < stdLengths[op]; i++) c.uleb();
        }
      }
    }
  }

  function parseLineUnit(c, strs, rows) {
    const version = c.u16();
    if (version < 2 || version > 5) return;
    let addressSize = 4;
    if (version >= 5) { addressSize = c.u8(); c.u8(); }
    const headerLength = c.u32();
    const programStart = c.pos + headerLength;
    const minInst = c.u8();
    if (version >= 4) c.u8();
    c.u8();                       // default_is_stmt
    const lineBase = c.i8();
    const lineRange = c.u8();
    const opcodeBase = c.u8();
    const stdLengths = [0];
    for (let i = 1; i < opcodeBase; i++) stdLengths.push(c.u8());

    const files = version >= 5
      ? readFileTableV5(c, Object.assign({ addressSize }, strs))
      : readFileTableV4(c);

    const header = { minInst, lineBase, lineRange, opcodeBase, stdLengths, addressSize, version };
    runLineProgram(new Cursor(c.b, programStart, c.end), header, files, rows);
  }

  function parseLineSection(section, strs) {
    const rows = [];
    const c = new Cursor(section);
    while (c.pos + 4 <= c.end) {
      const unitLength = c.u32();
      // 0xfffffff0..0xffffffff are reserved; 0xffffffff means DWARF64, which
      // clang does not emit for wasm32. Anything in that range means we have
      // lost the framing, so stop rather than produce nonsense rows.
      if (unitLength === 0 || unitLength >= 0xfffffff0) break;
      const unitEnd = Math.min(c.pos + unitLength, c.end);
      try {
        parseLineUnit(new Cursor(section, c.pos, unitEnd), strs, rows);
      } catch (e) { /* skip this unit, keep whatever the others gave us */ }
      c.pos = unitEnd;
    }
    return rows;
  }

  /* ---------- address space reconciliation ---------- */

  // LLVM has emitted line-table addresses both as module file offsets and as
  // offsets from the start of the code section body. Rather than guess by
  // version, see which reading puts more rows inside the code section.
  function chooseBias(rows, code) {
    if (!code || !rows.length) return 0;
    const size = code.end - code.start;
    let direct = 0, relative = 0;
    for (const row of rows) {
      if (row.address >= code.start && row.address < code.end) direct++;
      if (row.address < size) relative++;
    }
    return direct >= relative ? 0 : code.start;
  }

  /* ---------- Itanium demangling ---------- */

  const BUILTIN = {
    v: 'void', w: 'wchar_t', b: 'bool', c: 'char', a: 'signed char', h: 'unsigned char',
    s: 'short', t: 'unsigned short', i: 'int', j: 'unsigned int', l: 'long',
    m: 'unsigned long', x: 'long long', y: 'unsigned long long', n: '__int128',
    o: 'unsigned __int128', f: 'float', d: 'double', e: 'long double', z: '...',
  };
  const D_BUILTIN = {
    s: 'char16_t', i: 'char32_t', n: 'decltype(nullptr)', a: 'auto', c: 'decltype(auto)',
    h: '_Float16', f: '_Float32', d: '_Float64', u: 'char8_t',
  };
  const STD_ABBREV = {
    t: 'std', a: 'std::allocator', b: 'std::basic_string', s: 'std::string',
    i: 'std::istream', o: 'std::ostream', d: 'std::iostream',
  };
  const OPERATOR = {
    nw: ' new', na: ' new[]', dl: ' delete', da: ' delete[]', ps: '+', ng: '-',
    ad: '&', de: '*', co: '~', pl: '+', mi: '-', ml: '*', dv: '/', rm: '%',
    an: '&', or: '|', eo: '^', aS: '=', pL: '+=', mI: '-=', mL: '*=', dV: '/=',
    rM: '%=', aN: '&=', oR: '|=', eO: '^=', ls: '<<', rs: '>>', lS: '<<=',
    rS: '>>=', eq: '==', ne: '!=', lt: '<', gt: '>', le: '<=', ge: '>=',
    ss: '<=>', nt: '!', aa: '&&', oo: '||', pp: '++', mm: '--', cm: ',',
    pm: '->*', pt: '->', cl: '()', ix: '[]', qu: '?',
  };

  // Best-effort: covers what ordinary playground code mangles to. Anything
  // outside the subset throws and the caller keeps the raw symbol, so a gap
  // here shows up as an unreadable name and never as a wrong one.
  class Demangler {
    constructor(s) { this.s = s; this.i = 0; this.subs = []; this.templated = false; }

    fail(why) { throw new Error('demangle: ' + why + ' at ' + this.i + ' in ' + this.s); }
    peek() { return this.s[this.i]; }
    eat(ch) { if (this.s[this.i] !== ch) this.fail('expected ' + ch); this.i++; }

    run() {
      if (this.s.slice(0, 2) !== '_Z') this.fail('not a mangled name');
      this.i = 2;
      const name = this.parseName();
      const templated = this.templated;
      const trailing = name.cv ? ' ' + name.cv : '';
      if (this.i >= this.s.length) return name.text + trailing;

      const types = [];
      while (this.i < this.s.length) types.push(this.parseType());
      if (templated) types.shift();                              // template return type
      if (types.length === 1 && types[0] === 'void') types.length = 0;
      return name.text + '(' + types.join(', ') + ')' + trailing;
    }

    sourceName() {
      let n = 0;
      while (/[0-9]/.test(this.peek())) { n = n * 10 + Number(this.s[this.i++]); }
      if (!n || this.i + n > this.s.length) this.fail('bad source-name length');
      const s = this.s.slice(this.i, this.i + n);
      this.i += n;
      return s;
    }

    substitution() {
      this.eat('S');
      const ch = this.peek();
      if (ch === '_') { this.i++; return this.subAt(0); }
      if (ch in STD_ABBREV) { this.i++; return STD_ABBREV[ch]; }
      let id = 0;
      while (/[0-9A-Z]/.test(this.peek())) {
        const d = this.s[this.i++];
        id = id * 36 + (d >= '0' && d <= '9' ? Number(d) : d.charCodeAt(0) - 55);
      }
      this.eat('_');
      return this.subAt(id + 1);
    }

    subAt(index) {
      if (index >= this.subs.length) this.fail('substitution S' + index + ' out of range');
      return this.subs[index];
    }

    unqualifiedName(scope) {
      const ch = this.peek();
      if (/[0-9]/.test(ch)) return this.sourceName();
      if (ch === 'L') { this.i++; const n = this.sourceName(); while (/[0-9]/.test(this.peek())) this.i++; return n; }
      if (ch === 'C' && /[1-5]/.test(this.s[this.i + 1])) { this.i += 2; return lastSegment(scope); }
      if (ch === 'D' && /[0-5]/.test(this.s[this.i + 1])) { this.i += 2; return '~' + lastSegment(scope); }
      const code = this.s.slice(this.i, this.i + 2);
      if (code === 'cv') { this.i += 2; return 'operator ' + this.parseType(); }
      if (code in OPERATOR) { this.i += 2; return 'operator' + OPERATOR[code]; }
      this.fail('unqualified-name ' + ch);
    }

    templateArgs() {
      this.eat('I');
      const args = [];
      while (this.peek() !== 'E') args.push(this.templateArg());
      this.eat('E');
      return '<' + args.join(', ') + '>';
    }

    templateArg() {
      if (this.peek() !== 'L') return this.parseType();
      this.i++;
      const type = this.parseType();
      let text = '';
      while (this.i < this.s.length && this.peek() !== 'E') text += this.s[this.i++];
      this.eat('E');
      if (type === 'bool') return text === '0' ? 'false' : 'true';
      if (text[0] === 'n') return '-' + text.slice(1);
      return text || type;
    }

    // Substitution candidates are every prefix formed along the way. The last
    // one is left to the caller: as an encoding it is not a candidate at all,
    // and as a type parseType() is the one that records it.
    parseName() {
      const nested = this.peek() === 'N';
      let cv = '';
      if (nested) {
        this.i++;
        for (;;) {
          const ch = this.peek();
          if (ch === 'K') { cv = cv ? cv + ' const' : 'const'; this.i++; }
          else if (ch === 'V') { cv = cv ? cv + ' volatile' : 'volatile'; this.i++; }
          else if (ch === 'r') { this.i++; }
          else break;
        }
        if (this.peek() === 'R') { this.i++; cv += ' &'; }
        else if (this.peek() === 'O') { this.i++; cv += ' &&'; }
      }

      const snaps = [];
      let acc = '';
      this.templated = false;
      // Registered as we go, not at the end: template arguments are parsed in
      // the middle of a name and routinely refer back to the prefix that
      // encloses them, as in NSt3__26vectorIdNS_9allocatorIdEEE...
      const record = (text, fromSub) => {
        snaps.push({ text, sub: fromSub });
        if (!fromSub) this.subs.push(text);
      };
      const more = () => (nested ? this.peek() !== 'E' : this.i < this.s.length && this.startsName());

      while (more()) {
        if (this.peek() === 'I') {
          if (!acc) this.fail('template args without a name');
          acc += this.templateArgs();
          this.templated = true;
          record(acc, false);
          if (!nested) break;
        } else if (this.peek() === 'S' && !acc) {
          acc = this.substitution();
          record(acc, true);
        } else {
          const part = this.unqualifiedName(acc);
          acc = acc ? acc + '::' + part : part;
          this.templated = false;
          record(acc, false);
          if (!nested && this.peek() !== 'I') break;
        }
      }
      if (nested) this.eat('E');
      if (!snaps.length) this.fail('empty name');

      // The complete name is not itself a candidate. Nothing can have been
      // registered after it, so undoing that one push is enough.
      const last = snaps[snaps.length - 1];
      if (!last.sub) this.subs.pop();
      return { text: acc, cv, pureSub: snaps.length === 1 && last.sub };
    }

    startsName() {
      const ch = this.peek();
      return /[0-9NSL]/.test(ch) || ch === 'C' || ch === 'D' ||
        this.s.slice(this.i, this.i + 2) in OPERATOR;
    }

    parseType() {
      const ch = this.peek();
      if (ch === undefined) this.fail('type expected');
      if (ch in BUILTIN) { this.i++; return BUILTIN[ch]; }
      if (ch === 'D' && this.s[this.i + 1] in D_BUILTIN) { const k = this.s[this.i + 1]; this.i += 2; return D_BUILTIN[k]; }

      let result;
      if (ch === 'P') { this.i++; result = this.parseType() + '*'; }
      else if (ch === 'R') { this.i++; result = this.parseType() + '&'; }
      else if (ch === 'O') { this.i++; result = this.parseType() + '&&'; }
      else if (ch === 'K') { this.i++; result = this.parseType() + ' const'; }
      else if (ch === 'V') { this.i++; result = this.parseType() + ' volatile'; }
      else if (ch === 'r') { this.i++; result = this.parseType(); }
      else if (ch === 'S' || ch === 'N' || /[0-9]/.test(ch)) {
        const name = this.parseName();
        if (name.pureSub) return name.text;
        result = name.text;
      } else this.fail('type ' + ch);

      this.subs.push(result);
      return result;
    }
  }

  function lastSegment(name) {
    const base = String(name).replace(/<.*>$/, '');
    const at = base.lastIndexOf('::');
    return at < 0 ? base : base.slice(at + 2);
  }

  const LONG_STRING = 'std::basic_string<char, std::char_traits<char>, std::allocator<char>>';

  // libc++ marks names with an inline namespace (std::__2) and per-symbol ABI
  // tags. Both are versioning detail nobody writing the code ever typed.
  function tidy(text) {
    return text
      .split('std::__2::').join('std::')
      .split(LONG_STRING).join('std::string')
      .replace(/\[abi:[^\]]*\]/g, '');
  }

  // wasm-ld demangles as it writes the name section, so most of the time this
  // only has to tidy. The parser below is for the case where it did not:
  // --no-demangle, or a module linked by something else.
  function demangle(name) {
    if (!name) return name;
    if (name.slice(0, 2) !== '_Z') return tidy(name);
    try {
      const d = new Demangler(name);
      const text = d.run();
      return d.i === d.s.length ? tidy(text) : name;
    } catch (e) {
      return name;
    }
  }

  /* ---------- public surface ---------- */

  function parse(binary) {
    const { custom, code } = readSections(binary);
    let names = new Map();
    try {
      if (custom.has('name')) names = parseNameSection(custom.get('name'));
    } catch (e) { /* an unreadable name section only costs us the symbols */ }

    const strs = { str: custom.get('.debug_str'), lineStr: custom.get('.debug_line_str') };
    let rows = [];
    try {
      if (custom.has('.debug_line')) rows = parseLineSection(custom.get('.debug_line'), strs);
    } catch (e) { rows = []; }

    const bias = chooseBias(rows, code);
    rows = rows.filter(r => r.path);
    for (const row of rows) row.address += bias;
    rows.sort((a, b) => a.address - b.address || (a.end ? 1 : 0) - (b.end ? 1 : 0));

    return {
      hasNames: names.size > 0,
      hasLines: rows.length > 0,
      name(index) { return names.get(index) || null; },
      lookup(address) {
        let lo = 0, hi = rows.length - 1, found = -1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          if (rows[mid].address <= address) { found = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (found < 0 || rows[found].end) return null;
        return rows[found];
      },
    };
  }

  const FRAME = /wasm-function\[(\d+)\]:(0x[0-9a-fA-F]+)/g;

  function frames(error) {
    const stack = (error && error.stack) || '';
    const out = [];
    let match;
    FRAME.lastIndex = 0;
    while ((match = FRAME.exec(stack)) !== null) {
      out.push({ index: Number(match[1]), address: Number(match[2]) });
    }
    return out;
  }

  function shortPath(path) {
    return path.replace(/^\/work\//, '').replace(/^\.\//, '');
  }

  // Runtime scaffolding above the user's code: dropped until the first real
  // frame, so the crash site is the line the reader looks at first.
  const NOISE = /^(_start|__wasm_call_ctors|abort|_Exit|__cxa_|__wrap___cxa_|__assert)/;

  // wasi-libc renames main when it wraps it, so the deepest frame the user
  // wrote carries a name they would not recognise.
  const MAIN = /^(__original_main|__main_void)$/;

  // Everything that ends a program the hard way funnels through one of these.
  // Used to tell an abort() dressed up as a clean exit - assert, an uncaught
  // exception, std::terminate - from a plain `return 1` out of main.
  const ABORT = /^(abort|_Exit|__assert_fail|__cxa_throw|__cxa_bad_cast|__cxa_pure_virtual|_ZSt9terminatev|_ZSt10unexpectedv)/;

  function abortedThrough(error, info) {
    return frames(error).some(f => ABORT.test(info.name(f.index) || ''));
  }

  function backtrace(error, info) {
    const stack = frames(error);
    if (!stack.length) return null;

    const lines = [];
    let shown = 0;
    for (const frame of stack) {
      const raw = info.name(frame.index);
      if (shown === 0 && raw && NOISE.test(raw)) continue;
      const name = raw ? (MAIN.test(raw) ? 'main' : demangle(raw)) : 'wasm-function[' + frame.index + ']';
      const row = info.lookup(frame.address);
      const where = row
        ? shortPath(row.path) + ':' + row.line + (row.column ? ':' + row.column : '')
        : '0x' + frame.address.toString(16);
      lines.push('  \x1b[90m' + ('#' + shown).padEnd(3) + '\x1b[0m ' +
        name + '\n        \x1b[90mat\x1b[0m \x1b[96m' + where + '\x1b[0m');
      shown++;
      if (raw && MAIN.test(raw)) break;      // below main is only crt startup
    }
    return lines.length ? lines.join('\n') : null;
  }

  // Reads a NUL-terminated string out of a module's linear memory. The extra
  // copy is not waste: a threaded program's memory is a SharedArrayBuffer, and
  // TextDecoder refuses to decode a view onto shared memory.
  function readCString(memory, pointer) {
    if (!memory || !pointer) return '';
    const bytes = new Uint8Array(memory.buffer);
    let end = pointer;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return utf8(new Uint8Array(bytes.subarray(pointer, end)));
  }

  // std::type_info::name() is a bare type, not a _Z encoding, so it needs the
  // type production rather than the whole-symbol one: St12out_of_range.
  function demangleType(name) {
    if (!name) return name;
    try {
      const d = new Demangler(name);
      const text = d.parseType();
      return d.i === d.s.length ? tidy(text) : tidy(name);
    } catch (e) {
      return tidy(name);
    }
  }

  global.DebugInfo = { parse, demangle, demangleType, backtrace, abortedThrough, readCString };
})(typeof self !== 'undefined' ? self : this);
