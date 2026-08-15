# C++ Playground (self-hosted)

A cpp.sh-style C++ playground that runs entirely in the browser. **Clang 22 and
wasm-ld are WebAssembly binaries**; your code is compiled, linked and executed on
the client. No server-side compiler, no network calls, no accounts.

## Quick start

```bash
git clone <this repo> && cd CppCompilerSelfhosted
python serve.py
```

Open <http://localhost:8080/>. That is all — no build step, no compiler, no
dependencies beyond Python 3. The prebuilt toolchain ships in `dist/vendor/`,
so a clone is immediately runnable (and is therefore ~34 MB).

To deploy it somewhere else, copy `dist/` onto any static web server. It works
offline once loaded.

## Features

- **Clang 22.1.8** targeting `wasm32-wasip1`, built from source (see below)
- C++ syntax highlighting from a real parser (Tree-sitter), in VS Code's
  Dark+ colours: types, calls, members, parameters and macros are distinguished
- Multi-file projects (sources + headers, subdirectories supported)
- `-std=c++11/14/17/20`, `-O0..-O3/-Os`, plus free-form extra flags
- Full C++ standard library: libc++ built from the same LLVM release
- **Working exceptions**, using the standardized wasm EH opcodes
- stdout/stderr console with clang's colored diagnostics
- Interactive stdin: programs block on `std::cin` and you type into the console,
  with Ctrl+D for end of input; the *Program input* box preloads text before that
- Command line arguments, quoted like a shell (`--flag "two words"`)
- Dark and light themes (VS Code Dark+ / Light+), or follow the OS setting
- Stop button for runaway programs; resizable panes in both directions (drag a
  splitter, double-click one to reset)
- Export the project as a `.zip` containing a real, buildable `CMakeLists.txt`
- Project state is kept in `localStorage`

Download size is ~35 MB: clang 17.4 MB, wasm-ld 10.2 MB, sysroot 7.4 MB, all
gzipped and inflated in the browser.

## Why a server at all

Browsers refuse to load Web Workers and `fetch()` wasm from `file://`, so
opening `dist/index.html` directly does not work — the files have to come over
HTTP. `serve.py` is a plain static file server; `python -m http.server 8080
--directory dist` or nginx would do as well.

The server never sees or compiles your code. It hands over files and goes back
to sleep; clang runs in your browser, and the page keeps working if you kill the
network after it loads.

`serve.py` also sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, so the page is cross-origin
isolated and `SharedArrayBuffer` is available. Nothing needs it yet; interactive
stdin and threads would. A plain `python -m http.server` works too, minus that.

## Developing

`dist/` is committed, so only touch this if you change the app. After editing
`src/`, copy it over:

```bash
python tools/build.py
```

That refreshes the HTML/CSS/JS in `dist/` and leaves `dist/vendor/` (the
compiler binaries) untouched.

### Rebuilding the toolchain

Linux (WSL is fine), **no Docker**. Needs cmake, ninja, a C++17 host compiler,
curl, ~40 GB disk and about an hour on 16 cores:

```bash
bash tools/toolchain/build_wasm_clang.sh ~/wasm-clang
```

That downloads wasi-sdk 33 and the LLVM 22.1.8 release, applies the patches in
`tools/toolchain/patches/`, builds native tblgen, then cross-compiles clang and
lld to `wasm32-wasi`. It also rebuilds libc++/libc++abi/libunwind, because
wasi-sdk's prebuilt C++ libraries use the *legacy* wasm exception opcodes and
browsers reject a module mixing those with the standardized ones clang 22 emits.

Then pack the sysroot and install the result into `dist/vendor/`:

```bash
python tools/pack_sysroot.py --wasi-sdk ~/wasm-clang/wasi-sdk \
    --runtimes ~/wasm-clang/runtimes -o ~/wasm-clang/out/sysroot.tar.gz
python tools/build.py --toolchain ~/wasm-clang/out
```

### What the port needed

wasi-libc has no processes, signals, sockets or file locking, and LLVM assumes
all of them. Two mechanisms bridge that:

- `tools/toolchain/wasi-shim/` — missing headers (`pwd.h`, `sys/wait.h`) plus
  types and failing stubs for `fork`/`exec`, `sigaction`, rlimits, `dladdr` and
  friends, force-included into every translation unit. LLVM already handles
  these calls failing, so ENOSYS is both honest and sufficient.
- `tools/toolchain/patches/` — nine small patches where behaviour genuinely has
  to change. Two of them fix an upstream bug: LLVM and clang test `__WASM__`,
  but the macro clang actually defines is `__wasm__`, so the ABI-annotation
  macros end up undefined on wasm and headers fail to parse.

`tools/toolchain/wasi-shim/eh_tag.s` deserves a note: with legacy EH, libunwind
happened to define the `__cpp_exception` tag, so wasi-sdk's prebuilt archive
carries it. With standard EH every object only imports the tag and nothing
defines it, so anything that throws fails to link. A wasm tag can't be expressed
in C, hence three lines of assembly, archived into our `libunwind.a`.

## Layout

```
serve.py             static server with COOP/COEP — run this to use the app
dist/                committed, runnable output: the app + vendor/ toolchain
src/                 the app sources (plain HTML/CSS/JS, no build step, no deps)
  index.html
  css/app.css
  js/app.js          UI: files, tabs, editor, console, zip export
  js/worker.js       compile/link/run driver
  js/wasi.js         WASI preview1 host with an in-memory filesystem
  js/tar.js          tar reader + gzip inflate
  js/panels.js       draggable splitters between the panes
  js/stdin-channel.js  blocking stdin handoff to the worker
  js/zip.js          minimal store-only ZIP writer
  js/cmake.js        CMakeLists.txt / README generator for exports
  js/ts-highlight.js Tree-sitter highlighting, plugged into Ace's tokenizer
  js/ace-theme-vscode.js  VS Code Dark+ theme for Ace (ours)
  queries/           our highlight query refinements
  vendor/ace/        vendored Ace editor (BSD-3, see its README)
  vendor/tree-sitter/  vendored parser + C/C++ grammar (MIT, see its README)
tools/
  build.py           copies src/ into dist/
  pack_sysroot.py    builds sysroot.tar.gz
  toolchain/         sources for building clang (script, patches, posix shim)
```

The browser side has no third-party code: `js/wasi.js` is our own WASI host, and
clang talks to it over the standard `wasi_snapshot_preview1` ABI.

## Exported projects

*Download .zip* produces:

```
<project>/
  CMakeLists.txt     generated: sources, include dirs, standard, extra flags
  README.md
  <your files>
```

Build it with a normal native toolchain:

```bash
cmake -S . -B build
cmake --build build --config Release
```

## Limitations

- **Interactive stdin needs a cross-origin isolated server**, because blocking a
  worker for input requires SharedArrayBuffer. `serve.py` sends the necessary
  COOP/COEP headers; on a server that does not, the playground says so and falls
  back to the preloaded input box.
- **No threads, no networking** in compiled programs (single-threaded WASI
  sandbox with an in-memory filesystem).
- Exceptions need a browser with the standardized wasm EH proposal (Chrome 95+,
  Firefox 131+, Safari 18.4+).
- The generated `CMakeLists.txt` targets a native compiler, not the in-browser
  one, so anything relying on wasm-specific behaviour may need adjusting.
- First run downloads ~35 MB of toolchain and caches it in the browser.

## Licenses

The Ace editor (`src/vendor/ace/`) is BSD-3-Clause, Copyright (c) 2010 Ajax.org
B.V. Tree-sitter and the C/C++ grammars (`src/vendor/tree-sitter/`) are MIT.
All their licenses are retained verbatim alongside the files.

Clang, LLD, libc++ and libunwind are Apache-2.0 with the LLVM exception. The
wasi-sysroot components are from wasi-sdk (Apache-2.0 / MIT).

Everything else - `src/`, `tools/` and `serve.py` - is this project's own code,
MIT licensed; see `LICENSE`.
