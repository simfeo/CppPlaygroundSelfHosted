/*
 * Compile / link / run driver.
 *
 * clang and wasm-ld are WASI binaries (built by tools/toolchain/build_wasm_clang.sh);
 * they run on the WASI host in wasi.js over a shared in-memory filesystem, so the
 * object files one produces are the files the next one reads.
 */

self.importScripts('wasi.js', 'tar.js', 'stdin-channel.js');

const VENDOR = '../vendor/';
const SOURCE_EXT = /\.(c|cc|cpp|cxx|c\+\+)$/i;
const THREAD_HEADERS = /#\s*include\s*[<"](thread|future|shared_mutex|stop_token|pthread\.h)[>"]|std::(thread|jthread|async)/;
const TARGET = 'wasm32-wasip1';
const TARGET_THREADS = 'wasm32-wasip1-threads';

// Shared memory limits, in 64 KiB pages. Fixed here so the host can create a
// matching WebAssembly.Memory: the module imports it rather than defining it.
const THREAD_INITIAL_PAGES = 512;    // 32 MiB
const THREAD_MAX_PAGES = 4096;       // 256 MiB

let fs = null;
let resourceDir = null;      // /lib/clang/<version>, discovered from the sysroot
const modules = new Map();

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
  log(`${[argv0, ...args].join(' ')}\n`);

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
    `-O${opts.opt}`,
    '-fcolor-diagnostics',
    ...incDirs.map(d => `-I${d}`),
    ...splitFlags(opts.flags),
    '-o', obj,
    '/work/' + file.path,
  ]);
  return obj;
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

  const binary = fs.readFile(wasm);
  if (!binary) throw new Error('link produced no output');
  const module = await WebAssembly.compile(binary);

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

  const imports = opts.threads
    ? { ...wasi.imports, env: { memory }, wasi: { 'thread-spawn': spawnThread(module, memory) } }
    : wasi.imports;

  const instance = await WebAssembly.instantiate(module, imports);
  let code;
  try {
    code = wasi.start(instance);
  } catch (e) {
    stopThreads();
    // With standard wasm EH an uncaught C++ exception unwinds out of _start and
    // arrives here as a WebAssembly.Exception, whose default text says nothing.
    if (typeof WebAssembly.Exception === 'function' && e instanceof WebAssembly.Exception) {
      const hint = opts.threads ? ''
        : '\nIf it came from std::thread, tick the "threads" box and run again.';
      throw new Error('the program threw a C++ exception that nothing caught'
        + ' (std::terminate)' + hint);
    }
    throw e;
  }
  stopThreads();
  if (code !== 0) write(`\n\x1b[91mprogram exited with code ${code}\x1b[0m\n`);
  return code;
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
