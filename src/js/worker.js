/*
 * Compile / link / run driver.
 *
 * clang and wasm-ld are WASI binaries (built by tools/toolchain/build_wasm_clang.sh);
 * they run on the WASI host in wasi.js over a shared in-memory filesystem, so the
 * object files one produces are the files the next one reads.
 */

self.importScripts('wasi.js', 'tar.js', 'stdin-channel.js', 'debuginfo.js', 'dbgrewrite.js', 'dbgsession.js', 'dwarfinfo.js');

// V8 keeps 10 frames by default, which a C++ call chain blows through easily.
Error.stackTraceLimit = 64;

const VENDOR = '../vendor/';
const SOURCE_EXT = /\.(c|cc|cpp|cxx|c\+\+)$/i;
const THREAD_HEADERS = /#\s*include\s*[<"](thread|future|shared_mutex|stop_token|pthread\.h)[>"]|std::(thread|jthread|async)/;
const TARGET = 'wasm32-wasip1';
const TARGET_THREADS = 'wasm32-wasip1-threads';

// Shared memory limits, in 64 KiB pages. Fixed here so the host can create a
// matching WebAssembly.Memory: the module imports it rather than defining it.
const THREAD_INITIAL_PAGES = 512;    // 32 MiB
const THREAD_MAX_PAGES = 4096;       // 256 MiB

// Compiled once per target and kept outside /work, which is wiped between runs.
// The two targets cannot share an object file: one has atomics and shared
// memory in its ABI and the other does not.
const SHIM_URL = '../runtime/throw_shim.cpp';
const SHIM_SOURCE = '/opt/throw_shim.cpp';

let fs = null;
let resourceDir = null;      // /lib/clang/<version>, discovered from the sysroot
let lastThrow = null;        // most recent throw reported by the shim, if any
let programInstance = null;  // the running program, for the debugger's memory reads
const modules = new Map();
const shims = new Map();     // target -> object path

function post(msg) { self.postMessage(msg); }
function write(s) { post({ id: 'write', data: s }); }

function log(message) {
  write(`\x1b[1;93m>\x1b[0m ${message}`);
}

async function timed(message, promise) {
  const start = performance.now();
  log(`${message}...`);
  const result = await promise;
  write(` done \x1b[90m(${((performance.now() - start) / 1000).toFixed(1)}s)\x1b[0m\n`);
  return result;
}

async function getModule(name) {
  if (modules.has(name)) return modules.get(name);
  const promise = timed(`loading ${name}`, (async () => {
    const response = await fetch(`${VENDOR}${name}.gz`);
    if (!response.ok) throw new Error(`cannot fetch ${name}.gz: HTTP ${response.status}`);
    return WebAssembly.compile(await gunzip(await response.arrayBuffer()));
  })());
  modules.set(name, promise);
  return promise;
}

async function loadSysroot() {
  if (fs) return fs;
  const next = new MemFS();
  await timed('unpacking sysroot', (async () => {
    const response = await fetch(VENDOR + 'sysroot.tar.gz');
    if (!response.ok) throw new Error(`cannot fetch sysroot: HTTP ${response.status}`);
    const tar = await gunzip(await response.arrayBuffer());
    untar(tar, (name, data) => {
      next.mkdirp(name.replace(/\/[^/]*$/, ''));
      next.writeFile('/' + name, data.slice());
    });
  })());

  const clangDir = next.lookup('/lib/clang');
  if (!clangDir || !clangDir.children.size) throw new Error('sysroot has no /lib/clang');
  resourceDir = `/lib/clang/${[...clangDir.children.keys()][0]}`;

  next.mkdirp('/tmp');
  next.mkdirp('/work/obj');
  fs = next;
  return fs;
}

// Runs a WASI program to completion. Throws on a non-zero exit.
async function run(moduleName, argv0, args, options = {}) {
  const module = await getModule(moduleName);
  if (!options.quiet) log(`${[argv0, ...args].join(' ')}\n`);

  const wasi = new WASI({
    fs,
    args: [argv0, ...args],
    env: { PATH: '/bin', HOME: '/work', TMPDIR: '/tmp' },
    stdout: write,
    stderr: write,
    stdin: options.stdin || '',
  });

  const instance = await WebAssembly.instantiate(module, wasi.imports);
  const code = wasi.start(instance);
  write('\n');
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`${argv0} exited with code ${code}`);
  }
  return code;
}

function splitFlags(str) {
  return (str || '').trim().split(/\s+/).filter(Boolean);
}

function objName(path) {
  return '/work/obj/' + path.replace(/[\/\\]/g, '_').replace(SOURCE_EXT, '') + '.o';
}

function includeDirs(files) {
  const dirs = new Set(['/work']);
  for (const f of files) {
    const slash = f.path.lastIndexOf('/');
    if (slash > 0) dirs.add('/work/' + f.path.slice(0, slash));
  }
  return [...dirs];
}

async function compile(file, opts, incDirs) {
  const obj = objName(file.path);
  const isC = /\.c$/i.test(file.path);
  const target = opts.threads ? TARGET_THREADS : TARGET;
  await run('clang.wasm', '/bin/clang', [
    `--target=${target}`,
    ...(opts.threads ? ['-pthread'] : []),
    '--sysroot=/',
    `-resource-dir=${resourceDir}`,
    '-c',
    // Our libc++ is built with the standardized exception opcodes, so user code
    // must use them too - browsers reject a module that mixes both.
    ...(isC ? [] : [
      `-std=${opts.std}`,
      '-fwasm-exceptions', '-mllvm', '-wasm-use-legacy-eh=false',
      '-nostdinc++', '-isystem', opts.threads ? '/include/c++/v1-threads' : '/include/c++/v1',
    ]),
    // Debugging needs the variable and type DIEs, and needs them at -O0: an
    // optimised build has locals in wasm locals or gone entirely, and neither
    // can be read back. DWARF 4 keeps strings and addresses inline, where 5
    // would send them through .debug_str_offsets and .debug_addr.
    ...(opts.debug
      ? ['-O0', '-g', '-gdwarf-4']
      : [`-O${opts.opt}`, '-gline-tables-only']),
    '-fcolor-diagnostics',
    ...incDirs.map(d => `-I${d}`),
    ...splitFlags(opts.flags),
    '-o', obj,
    '/work/' + file.path,
  ]);
  return obj;
}

// The shim never changes, so each target's object is built once per worker and
// reused by every later run.
async function ensureShim(opts) {
  const target = opts.threads ? TARGET_THREADS : TARGET;
  if (shims.has(target)) return shims.get(target);

  const response = await fetch(SHIM_URL);
  if (!response.ok) throw new Error(`cannot fetch ${SHIM_URL}: HTTP ${response.status}`);
  fs.mkdirp('/opt');
  fs.writeFile(SHIM_SOURCE, await response.text());

  const object = `/opt/throw_shim-${target}.o`;
  // Settle clang's own load message first: timed() writes progress inline, so
  // two of them overlapping produce one interleaved line.
  await getModule('clang.wasm');
  await timed('preparing crash reporting', run('clang.wasm', '/bin/clang', [
    `--target=${target}`,
    ...(opts.threads ? ['-pthread'] : []),
    '--sysroot=/',
    `-resource-dir=${resourceDir}`,
    '-c',
    '-std=c++17',
    '-O1',
    '-fwasm-exceptions', '-mllvm', '-wasm-use-legacy-eh=false',
    '-nostdinc++', '-isystem', opts.threads ? '/include/c++/v1-threads' : '/include/c++/v1',
    '-o', object,
    SHIM_SOURCE,
  ], { quiet: true }));

  shims.set(target, object);
  return object;
}

async function link(objs, out, opts) {
  const target = opts.threads ? TARGET_THREADS : TARGET;
  const libdir = `/lib/${target}`;
  const builtins = opts.threads
    ? `${resourceDir}/lib/wasm32-unknown-wasip1-threads/libclang_rt.builtins.a`
    : `${resourceDir}/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a`;
  await run('wasm-ld.wasm', 'wasm-ld', [
    `-L${libdir}`,
    `${libdir}/crt1.o`,
    ...objs,
    shims.get(target),
    '--wrap=__cxa_throw',
    // Kept alive and locatable: the debugger's rewriter splices calls to it and
    // finds its index in the export section.
    '--export=__dbg_line',
    '--export=__dbg_local',
    '-lc', '-lc++', '-lc++abi', '-lunwind', '-lm',
    builtins,
    '-z', 'stack-size=1048576',
    // With threads every instance must attach to one shared memory, so the
    // module imports it; --export-memory is only implicit without --import-memory.
    ...(opts.threads
      ? ['--shared-memory', '--import-memory', '--export-memory',
         `--initial-memory=${THREAD_INITIAL_PAGES * 65536}`,
         `--max-memory=${THREAD_MAX_PAGES * 65536}`]
      : ['--max-memory=1073741824']),
    '-o', out,
  ]);
}

/* Splits a command line into argv, honouring single and double quotes so that
 * arguments containing spaces survive. */
function splitArgs(line) {
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(line || '')) !== null) {
    args.push(match[1] !== undefined ? match[1]
      : match[2] !== undefined ? match[2]
        : match[3]);
  }
  return args;
}

/* Input the program reads: whatever is in the input box first, then, if the
 * page gave us a shared buffer, live typing. Without that buffer there is no
 * way to block for input, so the preloaded text is simply followed by EOF. */
let stdinChannel = null;

function makeStdin(preloaded) {
  const encoder = new TextEncoder();
  let pending = preloaded ? encoder.encode(preloaded) : null;
  const readLive = stdinChannel
    ? StdinChannel.reader(stdinChannel, () => post({ id: 'stdin-request' }))
    : null;

  return function nextChunk() {
    if (pending) {
      const chunk = pending;
      pending = null;
      return chunk;
    }
    return readLive ? readLive() : null;
  };
}

/* wasi-threads: each thread is another worker running the same module against
 * the same memory.
 *
 * The threads are created by the page, not here. As soon as the program calls
 * join it blocks this worker in Atomics.wait, freezing its event loop - so a
 * thread started from here could never deliver its output or its errors. The
 * page is never blocked, so it owns the thread workers.
 *
 * thread-spawn must return a thread id synchronously, so the id is allocated
 * here and the worker starts a moment later; that is exactly what the spec
 * allows. */
let threadTid = 0;

function spawnThread(module, memory) {
  return function threadSpawn(startArg) {
    const tid = ++threadTid;
    post({ id: 'thread-spawn', data: { module, memory, tid, startArg } });
    return tid;
  };
}

function stopThreads() {
  post({ id: 'threads-done' });
}

async function build(payload) {
  const { files, stdin } = payload;
  const opts = payload.options;

  await loadSysroot();
  await ensureShim(opts);
  lastThrow = null;

  // Fresh project tree each run; the sysroot stays as it was unpacked.
  fs.unlink('/work');
  fs.mkdirp('/work/obj');
  for (const f of files) {
    const slash = f.path.lastIndexOf('/');
    if (slash > 0) fs.mkdirp('/work/' + f.path.slice(0, slash));
    fs.writeFile('/work/' + f.path, f.content);
  }

  const sources = files.filter(f => SOURCE_EXT.test(f.path));
  if (!sources.length) throw new Error('no source files (.c/.cc/.cpp/.cxx) in the project');

  // Threading headers compile fine without -pthread and then fail at run time
  // with an unhelpful exception, so say something before that happens.
  if (!opts.threads && files.some(f => THREAD_HEADERS.test(f.content))) {
    write('\x1b[93mwarning: this code uses threads but the "threads" box is not '
      + 'ticked, so std::thread will throw at run time\x1b[0m\n\n');
  }

  const incDirs = includeDirs(files);
  const objs = [];
  for (const src of sources) objs.push(await compile(src, opts, incDirs));

  const wasm = '/work/a.out.wasm';
  await link(objs, wasm, opts);

  const linked = fs.readFile(wasm);
  if (!linked) throw new Error('link produced no output');

  // In debug mode the linked module is rewritten to call __dbg_line at every
  // user source line; `binary` stays the original so DWARF lookups line up.
  const binary = linked;
  let session = null;
  let rewrite = null;
  let runnable = linked;
  if (opts.debug) {
    if (opts.threads) throw new Error('the debugger does not support threaded builds yet');
    if (typeof SharedArrayBuffer !== 'function') {
      throw new Error('the debugger needs a cross-origin isolated server (COOP/COEP) for SharedArrayBuffer');
    }
    const info = DebugInfo.parse(linked);
    if (!info.hasLines) throw new Error('no line table: cannot debug this build');
    const dwarf = DwarfInfo.parse(info.custom, info.bias);
    if (dwarf) dwarf.snapTo(DbgRewrite.bodies(linked));
    rewrite = DbgRewrite.instrument(linked, info.rows, {
      frameBase: (pc) => (dwarf ? dwarf.frameBaseAt(pc) : null),
      localSlots: (pc) => (dwarf ? dwarf.wasmLocalsAt(pc) : []),
    });
    if (!rewrite.instrumented) throw new Error('no debuggable lines found in your sources');
    runnable = rewrite.binary;
    session = DbgSession.create({
      post,
      points: rewrite.points,
      info,
      dwarf,
      memory: () => (programInstance ? programInstance.exports.memory : null),
    });
    post({ id: 'dbg-session', data: { sab: session.sab, layout: session.layout, points: rewrite.points } });
  }
  const module = await WebAssembly.compile(runnable);

  const argv = ['a.out', ...splitArgs(payload.args)];
  log(`running${argv.length > 1 ? ' ' + argv.slice(1).join(' ') : ''}\n\n`);
  const memory = opts.threads ? new WebAssembly.Memory({
    initial: THREAD_INITIAL_PAGES, maximum: THREAD_MAX_PAGES, shared: true,
  }) : null;

  const wasi = new WASI({
    fs,
    memory,
    args: argv,
    env: { USER: 'you', HOME: '/work', PATH: '/bin' },
    stdout: write,
    stderr: write,
    stdin: makeStdin(stdin || ''),
  });

  let instance = null;
  programInstance = null;
  const imports = {
    ...wasi.imports,
    playground: {
      on_line(id, framePointer) {
        if (session) session.onLine(id, framePointer);
      },
      on_local(slot, value) {
        if (session) session.onLocal(slot, value);
      },
      on_throw(type, what) {
        // The Error is only here for its stack: the shim calls this from the
        // frame that threw, so it still holds the whole chain below it.
        lastThrow = {
          type: DebugInfo.readCString(memory || (instance && instance.exports.memory), type),
          what: DebugInfo.readCString(memory || (instance && instance.exports.memory), what),
          error: new Error('throw'),
        };
      },
    },
    ...(opts.threads
      ? { env: { memory }, wasi: { 'thread-spawn': spawnThread(module, memory) } }
      : {}),
  };

  instance = await WebAssembly.instantiate(module, imports);
  programInstance = instance;
  let code;
  try {
    code = wasi.start(instance);
  } catch (e) {
    stopThreads();
    if (session) post({ id: 'dbg-ended' });
    reportCrash(e, binary, opts, rewrite);
    return TRAP_EXIT;
  }
  stopThreads();
  if (session) post({ id: 'dbg-ended' });
  if (code !== 0) write(`\n\x1b[91mprogram exited with code ${code}\x1b[0m\n`);
  return code;
}

// Matches the shell's convention for a process killed by a signal, which is
// what a trap is the wasm equivalent of.
const TRAP_EXIT = 134;

function reportCrash(error, binary, opts, rewrite) {
  // With standard wasm EH an uncaught C++ exception is not a trap: it unwinds
  // out of _start and arrives as a WebAssembly.Exception, which carries no JS
  // stack. What the throw shim recorded on the way past is used instead.
  if (typeof WebAssembly.Exception === 'function' && error instanceof WebAssembly.Exception) {
    write('\n\x1b[91mprogram crashed: uncaught exception (std::terminate)\x1b[0m\n');
    // The hint only earns its place when there is no backtrace to point at;
    // with one, the throw site already says whether threads were involved.
    if (!lastThrow) {
      write('\x1b[90m(nothing was recorded at the throw, so there is no backtrace)\x1b[0m\n');
      if (!opts.threads) {
        write('\x1b[90m(if it came from std::thread, tick the "threads" box and run again)\x1b[0m\n');
      }
      return;
    }
    const type = DebugInfo.demangleType(lastThrow.type) || 'unknown type';
    write(`\x1b[91m  ${type}${lastThrow.what ? ': ' + lastThrow.what : ''}\x1b[0m\n`);
    writeBacktrace(lastThrow.error, binary, rewrite);
    return;
  }
  const trap = error instanceof WebAssembly.RuntimeError
    ? error.message
    : (error && error.message) || String(error);
  write(`\n\x1b[91mprogram crashed: ${trap}\x1b[0m\n`);
  writeBacktrace(error, binary, rewrite);
}

// The debug sections are only read here: parsing them costs more than most
// programs take to run, and a run that ends normally never needs them.
function writeBacktrace(error, binary, rewrite) {
  let text = null;
  try {
    text = DebugInfo.backtrace(error, DebugInfo.parse(binary),
      rewrite ? { remap: rewrite.remap } : undefined);
  } catch (e) {
    write(`\x1b[90m(could not read debug info: ${e.message})\x1b[0m\n`);
    return;
  }
  if (text) write(`\n${text}\n`);
  else write('\x1b[90m(no wasm frames in the stack trace)\x1b[0m\n');
}

self.onmessage = async (event) => {
  const { id, data } = event.data;
  if (id === 'stdin-channel') {
    stdinChannel = data;
    return;
  }
  if (id !== 'run') return;
  try {
    const code = await build(data);
    post({ id: 'done', data: { ok: code === 0, message: `exit code ${code}` } });
  } catch (e) {
    post({ id: 'done', data: { ok: false, message: e && e.message ? e.message : String(e) } });
  }
};
