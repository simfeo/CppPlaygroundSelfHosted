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

self.importScripts('wasi.js', 'debuginfo.js');

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
  // The module is linked with --wrap=__cxa_throw and imports this, so a thread
  // instance has to supply it too or instantiation fails outright. A throw on a
  // spawned thread cannot be symbolized here (the debug sections live with the
  // run worker), but the type and message are worth keeping for the error line.
  let threw = null;
  const onThrow = (type, what) => {
    threw = {
      type: DebugInfo.readCString(memory, type),
      what: DebugInfo.readCString(memory, what),
    };
  };

  let nested = 0;
  const imports = {
    ...wasi.imports,
    // The throw shim is linked into every program, so a thread has to satisfy
    // its stop-point imports even though threaded programs are never debugged:
    // an import left unbound fails instantiation before the thread starts.
    playground: { on_throw: onThrow, on_line: () => {}, on_local: () => {} },
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
      const detail = threw
        ? `uncaught ${DebugInfo.demangleType(threw.type)}${threw.what ? ': ' + threw.what : ''}`
        : String(e);
      self.postMessage({ id: 'write', data: `\n\x1b[91mthread ${tid}: ${detail}\x1b[0m\n` });
    }
  }
  self.postMessage({ id: 'thread-exit', tid });
  self.close();
};
