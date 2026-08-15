/*
 * Blocking stdin channel between the page and the compile/run worker.
 *
 * WASI's fd_read is synchronous: when a program calls std::getline the worker
 * must stop dead until input exists. A worker can do that with Atomics.wait on
 * a SharedArrayBuffer, which the page fills in when you press Enter. Both sides
 * share the layout below.
 *
 * SharedArrayBuffer needs the page to be cross-origin isolated (COOP/COEP,
 * which serve.py sends). Without it there is no way to block, so the caller
 * falls back to the preloaded input box.
 */
(function (global) {
  'use strict';

  // Int32 control slots
  const STATE = 0;   // see below
  const LENGTH = 1;  // bytes available in the data region
  const HEADER = 8;  // Int32s reserved before the data region

  const IDLE = 0;
  const WAITING = 1; // worker is blocked, page owes it input
  const READY = 2;   // page has written data (or 0 bytes for end of input)

  const CAPACITY = 64 * 1024;

  function supported() {
    return typeof SharedArrayBuffer === 'function' && global.crossOriginIsolated !== false;
  }

  function createBuffer() {
    return new SharedArrayBuffer(HEADER * 4 + CAPACITY);
  }

  /* Worker side: blocks until the page provides input. */
  function reader(buffer, onRequest) {
    const control = new Int32Array(buffer, 0, HEADER);
    const data = new Uint8Array(buffer, HEADER * 4);
    return function readStdin() {
      Atomics.store(control, LENGTH, 0);
      Atomics.store(control, STATE, WAITING);
      onRequest();
      // Blocks this worker thread; the page is free to run and collect keys.
      Atomics.wait(control, STATE, WAITING);
      const length = Atomics.load(control, LENGTH);
      Atomics.store(control, STATE, IDLE);
      return length > 0 ? data.slice(0, length) : null;
    };
  }

  /* Page side: hands a line (or null to signal end of input) to the worker. */
  function writer(buffer) {
    const control = new Int32Array(buffer, 0, HEADER);
    const data = new Uint8Array(buffer, HEADER * 4);
    const encoder = new TextEncoder();
    return function writeStdin(text) {
      const bytes = text === null ? new Uint8Array(0) : encoder.encode(text);
      const length = Math.min(bytes.length, CAPACITY);
      data.set(bytes.subarray(0, length));
      Atomics.store(control, LENGTH, length);
      Atomics.store(control, STATE, READY);
      Atomics.notify(control, STATE);
    };
  }

  global.StdinChannel = { supported, createBuffer, reader, writer, CAPACITY };
})(typeof self !== 'undefined' ? self : this);
