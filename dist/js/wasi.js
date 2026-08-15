/*
 * WASI snapshot preview1 host with an in-memory filesystem.
 *
 * Enough of the ABI for clang, wasm-ld and ordinary user programs: files,
 * directories, stdio, and the metadata calls the LLVM VFS makes. No sockets,
 * no threads, no real clock beyond wall time.
 */
(function (global) {
  'use strict';

  const E = {
    SUCCESS: 0, ACCES: 2, BADF: 8, EXIST: 20, INVAL: 28, ISDIR: 31,
    LOOP: 32, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, PERM: 63, SPIPE: 70,
  };

  const FILETYPE = { UNKNOWN: 0, DIRECTORY: 3, REGULAR_FILE: 4, CHARACTER_DEVICE: 2 };

  const RIGHTS_ALL = 0xFFFFFFFFn | (0xFFFFFFFFn << 32n);

  const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
  const FDFLAGS = { APPEND: 1 };

  class ProcExit extends Error {
    constructor(code) { super(`exited with code ${code}`); this.code = code; }
  }

  /* ---------------- filesystem ---------------- */

  // Clang's FileManager keys files by (device, inode), so every node needs a
  // distinct one or headers get mistaken for each other.
  let nextInode = 1;

  class Node {
    constructor(type, name) {
      this.type = type;
      this.name = name;
      this.ino = nextInode++;
      this.children = type === 'dir' ? new Map() : null;
      this.data = type === 'file' ? new Uint8Array(0) : null;
      this.mtime = Date.now();
    }
    get size() { return this.type === 'file' ? this.data.length : 0; }
  }

  function splitPath(path) {
    return path.split('/').filter(p => p !== '' && p !== '.');
  }

  class MemFS {
    constructor() { this.root = new Node('dir', ''); }

    lookup(path) {
      let node = this.root;
      for (const part of splitPath(path)) {
        if (node.type !== 'dir') return null;
        if (part === '..') continue; // no parent links; clang never needs them
        node = node.children.get(part);
        if (!node) return null;
      }
      return node;
    }

    mkdirp(path) {
      let node = this.root;
      for (const part of splitPath(path)) {
        let next = node.children.get(part);
        if (!next) { next = new Node('dir', part); node.children.set(part, next); }
        else if (next.type !== 'dir') throw new Error(`${path} exists and is not a directory`);
        node = next;
      }
      return node;
    }

    parentOf(path) {
      const parts = splitPath(path);
      const name = parts.pop();
      let node = this.root;
      for (const part of parts) {
        node = node.children && node.children.get(part);
        if (!node || node.type !== 'dir') return [null, name];
      }
      return [node, name];
    }

    writeFile(path, contents) {
      const [parent, name] = this.parentOf(path);
      const dir = parent || this.mkdirp(path.replace(/\/[^/]*$/, ''));
      const node = new Node('file', name);
      node.data = typeof contents === 'string' ? new TextEncoder().encode(contents)
        : contents instanceof ArrayBuffer ? new Uint8Array(contents)
          : new Uint8Array(contents);
      dir.children.set(name, node);
      return node;
    }

    readFile(path) {
      const node = this.lookup(path);
      return node && node.type === 'file' ? node.data : null;
    }

    unlink(path) {
      const [parent, name] = this.parentOf(path);
      if (!parent) return false;
      return parent.children.delete(name);
    }
  }

  /* ---------------- open file descriptors ---------------- */

  class FileDesc {
    constructor(node, path, opts) {
      this.node = node;
      this.path = path;
      this.offset = 0;
      this.append = !!(opts && opts.append);
      this.dirEntries = null;
    }
  }

  class StdioDesc {
    constructor(kind, io) { this.kind = kind; this.io = io; }
  }

  /* ---------------- the host ---------------- */

  class WASI {
    // options: {fs, args, env, stdout, stderr, stdin}
    constructor(options) {
      this.fs = options.fs || new MemFS();
      this.args = options.args || ['program'];
      this.env = options.env || {};
      this.onStdout = options.stdout || (() => { });
      this.onStderr = options.stderr || options.stdout || (() => { });
      // stdin is either fixed bytes/text, or a function called when the program
      // reads and the buffer is empty. The function blocks until input arrives
      // and returns null at end of input - that is what makes std::cin
      // interactive.
      this.stdinFn = typeof options.stdin === 'function' ? options.stdin : null;
      this.stdinBytes = this.stdinFn ? new Uint8Array(0)
        : options.stdin instanceof Uint8Array ? options.stdin
          : new TextEncoder().encode(options.stdin || '');
      this.stdinPos = 0;
      this.stdinEof = false;

      this.fds = new Map();
      this.fds.set(0, new StdioDesc('stdin', null));
      this.fds.set(1, new StdioDesc('stdout', this.onStdout));
      this.fds.set(2, new StdioDesc('stderr', this.onStderr));
      // Preopened root, so absolute paths resolve.
      this.fds.set(3, new FileDesc(this.fs.root, '/'));
      this.preopens = new Map([[3, '/']]);
      this.nextFd = 4;

      this.instance = null;
      this.exitCode = null;
      this.imports = this.buildImports();
    }

    /* --- memory helpers --- */

    get view() {
      // The module's memory can be detached by growth; re-read each time.
      const buffer = this.instance.exports.memory.buffer;
      if (this._buffer !== buffer) {
        this._buffer = buffer;
        this._view = new DataView(buffer);
        this._u8 = new Uint8Array(buffer);
      }
      return this._view;
    }
    get u8() { this.view; return this._u8; }

    readString(ptr, len) {
      return new TextDecoder('utf-8').decode(this.u8.subarray(ptr, ptr + len));
    }

    /* Tops up the stdin buffer from the live source when it runs dry. */
    fillStdin() {
      if (!this.stdinFn || this.stdinEof) return;
      if (this.stdinPos < this.stdinBytes.length) return;
      const more = this.stdinFn();
      if (!more || more.length === 0) {
        this.stdinEof = true;
        return;
      }
      this.stdinBytes = more;
      this.stdinPos = 0;
    }

    iovs(ptr, count) {
      const out = [];
      for (let i = 0; i < count; i++) {
        const buf = this.view.getUint32(ptr + i * 8, true);
        const len = this.view.getUint32(ptr + i * 8 + 4, true);
        out.push(this.u8.subarray(buf, buf + len));
      }
      return out;
    }

    allocFd(desc) {
      const fd = this.nextFd++;
      this.fds.set(fd, desc);
      return fd;
    }

    resolve(dirfd, path) {
      const base = this.fds.get(dirfd);
      if (path.startsWith('/')) return path;
      const prefix = base instanceof FileDesc ? base.path : '/';
      return (prefix === '/' ? '' : prefix) + '/' + path;
    }

    /* --- filestat/fdstat writers --- */

    writeFilestat(ptr, node) {
      const v = this.view;
      const mtimeNs = BigInt(Math.round(node.mtime)) * 1000000n;
      v.setBigUint64(ptr, 1n, true);                        // dev
      v.setBigUint64(ptr + 8, BigInt(node.ino || 0), true); // ino
      v.setUint8(ptr + 16, node.type === 'dir' ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE);
      v.setBigUint64(ptr + 24, 1n, true);       // nlink
      v.setBigUint64(ptr + 32, BigInt(node.size), true);
      v.setBigUint64(ptr + 40, mtimeNs, true);  // atim
      v.setBigUint64(ptr + 48, mtimeNs, true);  // mtim
      v.setBigUint64(ptr + 56, mtimeNs, true);  // ctim
    }

    /* --- the import object --- */

    buildImports() {
      const self_ = this;
      const ok = E.SUCCESS;

      const api = {
        proc_exit(code) { throw new ProcExit(code); },

        args_sizes_get(countPtr, sizePtr) {
          const enc = new TextEncoder();
          let size = 0;
          for (const a of self_.args) size += enc.encode(a).length + 1;
          self_.view.setUint32(countPtr, self_.args.length, true);
          self_.view.setUint32(sizePtr, size, true);
          return ok;
        },

        args_get(ptrsPtr, bufPtr) {
          const enc = new TextEncoder();
          for (const arg of self_.args) {
            self_.view.setUint32(ptrsPtr, bufPtr, true);
            ptrsPtr += 4;
            const bytes = enc.encode(arg);
            self_.u8.set(bytes, bufPtr);
            self_.u8[bufPtr + bytes.length] = 0;
            bufPtr += bytes.length + 1;
          }
          return ok;
        },

        environ_sizes_get(countPtr, sizePtr) {
          const enc = new TextEncoder();
          const names = Object.keys(self_.env);
          let size = 0;
          for (const n of names) size += enc.encode(`${n}=${self_.env[n]}`).length + 1;
          self_.view.setUint32(countPtr, names.length, true);
          self_.view.setUint32(sizePtr, size, true);
          return ok;
        },

        environ_get(ptrsPtr, bufPtr) {
          const enc = new TextEncoder();
          for (const name of Object.keys(self_.env)) {
            self_.view.setUint32(ptrsPtr, bufPtr, true);
            ptrsPtr += 4;
            const bytes = enc.encode(`${name}=${self_.env[name]}`);
            self_.u8.set(bytes, bufPtr);
            self_.u8[bufPtr + bytes.length] = 0;
            bufPtr += bytes.length + 1;
          }
          return ok;
        },

        clock_res_get(id, ptr) {
          self_.view.setBigUint64(ptr, 1000000n, true);
          return ok;
        },

        clock_time_get(id, precision, ptr) {
          self_.view.setBigUint64(ptr, BigInt(Date.now()) * 1000000n, true);
          return ok;
        },

        random_get(ptr, len) {
          crypto.getRandomValues(self_.u8.subarray(ptr, ptr + len));
          return ok;
        },

        sched_yield() { return ok; },

        fd_prestat_get(fd, ptr) {
          const name = self_.preopens.get(fd);
          if (name === undefined) return E.BADF;
          self_.view.setUint8(ptr, 0); // preopentype: dir
          self_.view.setUint32(ptr + 4, new TextEncoder().encode(name).length, true);
          return ok;
        },

        fd_prestat_dir_name(fd, ptr, len) {
          const name = self_.preopens.get(fd);
          if (name === undefined) return E.BADF;
          const bytes = new TextEncoder().encode(name);
          self_.u8.set(bytes.subarray(0, len), ptr);
          return ok;
        },

        fd_fdstat_get(fd, ptr) {
          const desc = self_.fds.get(fd);
          if (!desc) return E.BADF;
          const v = self_.view;
          const type = desc instanceof StdioDesc ? FILETYPE.CHARACTER_DEVICE
            : desc.node.type === 'dir' ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE;
          v.setUint8(ptr, type);
          v.setUint16(ptr + 2, 0, true);
          v.setBigUint64(ptr + 8, RIGHTS_ALL, true);
          v.setBigUint64(ptr + 16, RIGHTS_ALL, true);
          return ok;
        },

        fd_fdstat_set_flags(fd, flags) { return ok; },
        fd_fdstat_set_rights(fd, base, inheriting) { return ok; },

        fd_filestat_get(fd, ptr) {
          const desc = self_.fds.get(fd);
          if (!desc) return E.BADF;
          if (desc instanceof StdioDesc) {
            self_.writeFilestat(ptr, { type: 'file', size: 0, mtime: Date.now() });
            self_.view.setUint8(ptr + 16, FILETYPE.CHARACTER_DEVICE);
            return ok;
          }
          self_.writeFilestat(ptr, desc.node);
          return ok;
        },

        fd_filestat_set_size(fd, size) {
          const desc = self_.fds.get(fd);
          if (!desc || desc instanceof StdioDesc) return E.BADF;
          const next = new Uint8Array(Number(size));
          next.set(desc.node.data.subarray(0, Number(size)));
          desc.node.data = next;
          return ok;
        },

        fd_filestat_set_times(fd, atim, mtim, flags) { return ok; },

        fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
          const desc = self_.fds.get(fd);
          if (!desc) return E.BADF;
          let read = 0;
          for (const buf of self_.iovs(iovsPtr, iovsLen)) {
            let chunk;
            if (desc instanceof StdioDesc) {
              if (desc.kind !== 'stdin') return E.BADF;
              self_.fillStdin();
              chunk = self_.stdinBytes.subarray(self_.stdinPos, self_.stdinPos + buf.length);
              self_.stdinPos += chunk.length;
            } else {
              chunk = desc.node.data.subarray(desc.offset, desc.offset + buf.length);
              desc.offset += chunk.length;
            }
            buf.set(chunk);
            read += chunk.length;
            if (chunk.length < buf.length) break;
          }
          self_.view.setUint32(nreadPtr, read, true);
          return ok;
        },

        fd_pread(fd, iovsPtr, iovsLen, offset, nreadPtr) {
          const desc = self_.fds.get(fd);
          if (!desc || desc instanceof StdioDesc) return E.BADF;
          let pos = Number(offset), read = 0;
          for (const buf of self_.iovs(iovsPtr, iovsLen)) {
            const chunk = desc.node.data.subarray(pos, pos + buf.length);
            buf.set(chunk);
            pos += chunk.length;
            read += chunk.length;
            if (chunk.length < buf.length) break;
          }
          self_.view.setUint32(nreadPtr, read, true);
          return ok;
        },

        fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
          const desc = self_.fds.get(fd);
          if (!desc) return E.BADF;
          let written = 0;
          for (const buf of self_.iovs(iovsPtr, iovsLen)) {
            if (desc instanceof StdioDesc) {
              if (desc.kind === 'stdin') return E.BADF;
              desc.io(new TextDecoder('utf-8').decode(buf));
            } else {
              const node = desc.node;
              const at = desc.append ? node.data.length : desc.offset;
              const end = at + buf.length;
              if (end > node.data.length) {
                const next = new Uint8Array(end);
                next.set(node.data);
                node.data = next;
              }
              node.data.set(buf, at);
              desc.offset = end;
              node.mtime = Date.now();
            }
            written += buf.length;
          }
          self_.view.setUint32(nwrittenPtr, written, true);
          return ok;
        },

        fd_pwrite(fd, iovsPtr, iovsLen, offset, nwrittenPtr) {
          const desc = self_.fds.get(fd);
          if (!desc || desc instanceof StdioDesc) return E.BADF;
          let pos = Number(offset), written = 0;
          const node = desc.node;
          for (const buf of self_.iovs(iovsPtr, iovsLen)) {
            const end = pos + buf.length;
            if (end > node.data.length) {
              const next = new Uint8Array(end);
              next.set(node.data);
              node.data = next;
            }
            node.data.set(buf, pos);
            pos = end;
            written += buf.length;
          }
          self_.view.setUint32(nwrittenPtr, written, true);
          return ok;
        },

        fd_seek(fd, offset, whence, newOffsetPtr) {
          const desc = self_.fds.get(fd);
          if (!desc) return E.BADF;
          if (desc instanceof StdioDesc) return E.SPIPE;
          const delta = Number(offset);
          if (whence === 0) desc.offset = delta;
          else if (whence === 1) desc.offset += delta;
          else if (whence === 2) desc.offset = desc.node.data.length + delta;
          else return E.INVAL;
          if (desc.offset < 0) { desc.offset = 0; return E.INVAL; }
          self_.view.setBigUint64(newOffsetPtr, BigInt(desc.offset), true);
          return ok;
        },

        fd_tell(fd, ptr) {
          const desc = self_.fds.get(fd);
          if (!desc || desc instanceof StdioDesc) return E.BADF;
          self_.view.setBigUint64(ptr, BigInt(desc.offset), true);
          return ok;
        },

        fd_close(fd) {
          if (!self_.fds.has(fd)) return E.BADF;
          if (fd > 3) self_.fds.delete(fd);
          return ok;
        },

        fd_renumber(from, to) {
          const desc = self_.fds.get(from);
          if (!desc) return E.BADF;
          self_.fds.set(to, desc);
          self_.fds.delete(from);
          return ok;
        },

        fd_sync() { return ok; },
        fd_datasync() { return ok; },
        fd_advise() { return ok; },
        fd_allocate() { return ok; },

        fd_readdir(fd, bufPtr, bufLen, cookie, usedPtr) {
          const desc = self_.fds.get(fd);
          if (!desc || desc instanceof StdioDesc || desc.node.type !== 'dir') return E.BADF;
          const entries = [...desc.node.children.values()];
          const enc = new TextEncoder();
          let used = 0;
          let index = Number(cookie);
          while (index < entries.length) {
            const node = entries[index];
            const name = enc.encode(node.name);
            if (used + 24 + name.length > bufLen) break;
            const v = self_.view;
            v.setBigUint64(bufPtr + used, BigInt(index + 1), true);   // d_next
            v.setBigUint64(bufPtr + used + 8, BigInt(node.ino), true);
            v.setUint32(bufPtr + used + 16, name.length, true);
            v.setUint8(bufPtr + used + 20,
              node.type === 'dir' ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE);
            self_.u8.set(name, bufPtr + used + 24);
            used += 24 + name.length;
            index++;
          }
          self_.view.setUint32(usedPtr, used, true);
          return ok;
        },

        path_open(dirfd, dirflags, pathPtr, pathLen, oflags, rightsBase, rightsInh,
                  fdflags, fdPtr) {
          const path = self_.resolve(dirfd, self_.readString(pathPtr, pathLen));
          let node = self_.fs.lookup(path);

          if (oflags & OFLAGS.DIRECTORY && node && node.type !== 'dir') return E.NOTDIR;
          if (node && (oflags & OFLAGS.EXCL) && (oflags & OFLAGS.CREAT)) return E.EXIST;

          if (!node) {
            if (!(oflags & OFLAGS.CREAT)) return E.NOENT;
            const [parent] = self_.fs.parentOf(path);
            if (!parent) return E.NOENT;
            node = self_.fs.writeFile(path, new Uint8Array(0));
          } else if ((oflags & OFLAGS.TRUNC) && node.type === 'file') {
            node.data = new Uint8Array(0);
          }

          const desc = new FileDesc(node, path, { append: !!(fdflags & FDFLAGS.APPEND) });
          self_.view.setUint32(fdPtr, self_.allocFd(desc), true);
          return ok;
        },

        path_filestat_get(dirfd, flags, pathPtr, pathLen, ptr) {
          const path = self_.resolve(dirfd, self_.readString(pathPtr, pathLen));
          const node = self_.fs.lookup(path);
          if (!node) return E.NOENT;
          self_.writeFilestat(ptr, node);
          return ok;
        },

        path_filestat_set_times() { return ok; },

        path_create_directory(dirfd, pathPtr, pathLen) {
          const path = self_.resolve(dirfd, self_.readString(pathPtr, pathLen));
          if (self_.fs.lookup(path)) return E.EXIST;
          self_.fs.mkdirp(path);
          return ok;
        },

        path_unlink_file(dirfd, pathPtr, pathLen) {
          const path = self_.resolve(dirfd, self_.readString(pathPtr, pathLen));
          const node = self_.fs.lookup(path);
          if (!node) return E.NOENT;
          if (node.type === 'dir') return E.ISDIR;
          self_.fs.unlink(path);
          return ok;
        },

        path_remove_directory(dirfd, pathPtr, pathLen) {
          const path = self_.resolve(dirfd, self_.readString(pathPtr, pathLen));
          const node = self_.fs.lookup(path);
          if (!node) return E.NOENT;
          if (node.type !== 'dir') return E.NOTDIR;
          if (node.children.size) return E.NOTEMPTY;
          self_.fs.unlink(path);
          return ok;
        },

        path_rename(oldFd, oldPtr, oldLen, newFd, newPtr, newLen) {
          const from = self_.resolve(oldFd, self_.readString(oldPtr, oldLen));
          const to = self_.resolve(newFd, self_.readString(newPtr, newLen));
          const node = self_.fs.lookup(from);
          if (!node) return E.NOENT;
          const [parent, name] = self_.fs.parentOf(to);
          if (!parent) return E.NOENT;
          self_.fs.unlink(from);
          node.name = name;
          parent.children.set(name, node);
          return ok;
        },

        // Symlinks are not modelled; report their absence rather than lying.
        path_symlink() { return E.NOSYS; },
        path_readlink() { return E.INVAL; },
        path_link() { return E.NOSYS; },

        poll_oneoff(inPtr, outPtr, nsubs, neventsPtr) {
          self_.view.setUint32(neventsPtr, 0, true);
          return E.NOSYS;
        },

        proc_raise() { return E.NOSYS; },
        sock_accept() { return E.NOSYS; },
        sock_recv() { return E.NOSYS; },
        sock_send() { return E.NOSYS; },
        sock_shutdown() { return E.NOSYS; },
      };

      return { wasi_snapshot_preview1: api, wasi_unstable: api };
    }

    /* --- running --- */

    // Returns the process exit code (0 on a clean _start return).
    start(instance) {
      this.instance = instance;
      this._buffer = null;
      try {
        instance.exports._start();
        return 0;
      } catch (e) {
        if (e instanceof ProcExit) return e.code;
        throw e;
      }
    }
  }

  global.WASI = WASI;
  global.MemFS = MemFS;
  global.WASIProcExit = ProcExit;
})(typeof self !== 'undefined' ? self : this);
