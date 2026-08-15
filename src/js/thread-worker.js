/*
 * One spawned thread of a wasi-threads program.
 *
 * wasi-threads works by instantiating the *same* module again, against the
 * *same* shared memory, and entering it through wasi_thread_start instead of
 * _start. That is what makes std::thread work: the instances share linear
 * memory, so mutexes, atomics and the C++ runtime all see the same state.
 *
 * The filesystem does not cross worker boundaries - it lives in the run
 * worker's JavaScript heap - so file calls from a spawned thread fail. Writes
 * to stdout and stderr are forwarded to the run worker instead.
 */

self.importScripts('wasi.js');

self.onmessage = async (event) => {
  const { module, memory, tid, startArg } = event.data;

  const write = s => self.postMessage({ id: 'write', data: s });

  const wasi = new WASI({
    memory,
    args: ['a.out'],
    env: {},
    stdout: write,
    stderr: write,
  });

  // A thread may itself spawn threads. Like the run worker, it asks the page to
  // do it: this worker blocks too, so it could not service a child of its own.
  let nested = 0;
  const imports = {
    ...wasi.imports,
    env: { memory },
    wasi: {
      'thread-spawn': (arg) => {
        const child = tid * 1000 + (++nested);
        self.postMessage({ id: 'thread-spawn', data: { module, memory, tid: child, startArg: arg } });
        return child;
      },
    },
  };

  try {
    const instance = await WebAssembly.instantiate(module, imports);
    wasi.attach(instance);
    instance.exports.wasi_thread_start(tid, startArg);
  } catch (e) {
    // A thread that calls exit() unwinds through proc_exit; that is not an error.
    if (!(e && e.constructor && e.constructor.name === 'ProcExit')) {
      self.postMessage({ id: 'write', data: `\n\x1b[91mthread ${tid}: ${e}\x1b[0m\n` });
    }
  }
  self.postMessage({ id: 'thread-exit', tid });
  self.close();
};
