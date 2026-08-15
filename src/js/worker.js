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
const TARGET = 'wasm32-wasip1';

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
  await run('clang.wasm', '/bin/clang', [
    `--target=${TARGET}`,
    '--sysroot=/',
    `-resource-dir=${resourceDir}`,
    '-c',
    // Our libc++ is built with the standardized exception opcodes, so user code
    // must use them too - browsers reject a module that mixes both.
    ...(isC ? [] : [
      `-std=${opts.std}`,
      '-fwasm-exceptions', '-mllvm', '-wasm-use-legacy-eh=false',
      '-nostdinc++', '-isystem', '/include/c++/v1',
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

async function link(objs, out) {
  const libdir = `/lib/${TARGET}`;
  await run('wasm-ld.wasm', 'wasm-ld', [
    `-L${libdir}`,
    `${libdir}/crt1.o`,
    ...objs,
    '-lc', '-lc++', '-lc++abi', '-lunwind', '-lm',
    `${resourceDir}/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a`,
    '-z', 'stack-size=1048576',
    '--max-memory=1073741824',
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

  const incDirs = includeDirs(files);
  const objs = [];
  for (const src of sources) objs.push(await compile(src, opts, incDirs));

  const wasm = '/work/a.out.wasm';
  await link(objs, wasm);

  const binary = fs.readFile(wasm);
  if (!binary) throw new Error('link produced no output');
  const module = await WebAssembly.compile(binary);

  const argv = ['a.out', ...splitArgs(payload.args)];
  log(`running${argv.length > 1 ? ' ' + argv.slice(1).join(' ') : ''}\n\n`);
  const wasi = new WASI({
    fs,
    args: argv,
    env: { USER: 'you', HOME: '/work', PATH: '/bin' },
    stdout: write,
    stderr: write,
    stdin: makeStdin(stdin || ''),
  });
  const instance = await WebAssembly.instantiate(module, wasi.imports);
  const code = wasi.start(instance);
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
