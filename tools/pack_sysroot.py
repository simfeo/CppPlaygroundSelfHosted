"""Packs a wasi-sdk sysroot into the tar the browser worker unpacks.

Only the wasm32-wasip1 slice is taken (wasi-sdk ships several targets), and the
layout mirrors a real installation so clang's driver finds headers and libs with
argv[0]=/bin/clang and --sysroot=/.

    python tools/pack_sysroot.py --wasi-sdk ~/wasm-clang/wasi-sdk -o dist/vendor/sysroot.tar.gz
"""

import argparse
import gzip
import io
import os
import sys
import tarfile

TARGET = "wasm32-wasip1"
TARGET_THREADS = "wasm32-wasip1-threads"

# From wasi-sdk: (source path relative to the sdk, destination path in the tar)
TREES = [
    (f"share/wasi-sysroot/include/{TARGET}", f"include/{TARGET}"),
    (f"share/wasi-sysroot/include/{TARGET_THREADS}", f"include/{TARGET_THREADS}"),
    ("lib/clang/{v}/include", "lib/clang/{v}/include"),
]

FILES = [
    (f"share/wasi-sysroot/lib/{TARGET}/crt1.o", f"lib/{TARGET}/crt1.o"),
    (f"share/wasi-sysroot/lib/{TARGET_THREADS}/crt1.o", f"lib/{TARGET_THREADS}/crt1.o"),
    (f"share/wasi-sysroot/lib/{TARGET_THREADS}/libc.a", f"lib/{TARGET_THREADS}/libc.a"),
    (f"share/wasi-sysroot/lib/{TARGET_THREADS}/libm.a", f"lib/{TARGET_THREADS}/libm.a"),
    (f"share/wasi-sysroot/lib/{TARGET_THREADS}/libsetjmp.a", f"lib/{TARGET_THREADS}/libsetjmp.a"),
    ("lib/clang/{v}/lib/wasm32-unknown-wasip1-threads/libclang_rt.builtins.a",
     "lib/clang/{v}/lib/wasm32-unknown-wasip1-threads/libclang_rt.builtins.a"),
    (f"share/wasi-sysroot/lib/{TARGET}/libc.a", f"lib/{TARGET}/libc.a"),
    (f"share/wasi-sysroot/lib/{TARGET}/libm.a", f"lib/{TARGET}/libm.a"),
    (f"share/wasi-sysroot/lib/{TARGET}/libsetjmp.a", f"lib/{TARGET}/libsetjmp.a"),
    ("lib/clang/{v}/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a",
     "lib/clang/{v}/lib/wasm32-unknown-wasip1/libclang_rt.builtins.a"),
]

# From our own runtimes build: wasi-sdk's prebuilt C++ libraries use the legacy
# wasm exception opcodes, which browsers refuse to mix with the standard ones
# clang 22 emits, so both the libraries and their headers come from us.
RUNTIME_TREES = [
    ("include/c++", "include/c++"),
]

RUNTIME_FILES = [
    ("lib/libc++.a", f"lib/{TARGET}/libc++.a"),
    ("lib/libc++abi.a", f"lib/{TARGET}/libc++abi.a"),
    ("lib/libunwind.a", f"lib/{TARGET}/libunwind.a"),
]

# The threads build has its own libraries and its own __config_site, so its
# headers are kept separate rather than merged with the single-threaded ones.
THREAD_TREES = [
    ("include/c++", "include/c++/v1-threads-tmp"),
]

THREAD_FILES = [
    ("lib/libc++.a", f"lib/{TARGET_THREADS}/libc++.a"),
    ("lib/libc++abi.a", f"lib/{TARGET_THREADS}/libc++abi.a"),
    ("lib/libunwind.a", f"lib/{TARGET_THREADS}/libunwind.a"),
]


def clang_version(sdk):
    versions = sorted(os.listdir(os.path.join(sdk, "lib", "clang")))
    if not versions:
        sys.exit(f"no clang resource dir under {sdk}/lib/clang")
    return versions[-1]


def add_file(tar, src, name):
    info = tarfile.TarInfo(name)
    info.size = os.path.getsize(src)
    info.mode = 0o644
    info.mtime = 0
    with open(src, "rb") as handle:
        tar.addfile(info, handle)


def add_tree(tar, src_root, dst_root, counts):
    for root, _, files in os.walk(src_root):
        for name in sorted(files):
            src = os.path.join(root, name)
            rel = os.path.relpath(src, src_root).replace(os.sep, "/")
            add_file(tar, src, f"{dst_root}/{rel}")
            counts[0] += 1
            counts[1] += os.path.getsize(src)


def main():
    parser = argparse.ArgumentParser(prog="pack_sysroot")
    parser.add_argument("--wasi-sdk", required=True, help="path to an extracted wasi-sdk")
    parser.add_argument("--runtimes-threads", required=True,
                        help="install prefix of the threads libc++ build "
                             "(runtimes-threads/ from build_wasm_clang.sh)")
    parser.add_argument("--runtimes", required=True,
                        help="install prefix of the standard-EH libc++ build "
                             "(the runtimes/ directory produced by build_wasm_clang.sh)")
    parser.add_argument("-o", "--out", required=True, help="output .tar.gz")
    args = parser.parse_args()

    sdk = os.path.abspath(os.path.expanduser(args.wasi_sdk))
    runtimes = os.path.abspath(os.path.expanduser(args.runtimes))
    runtimes_threads = os.path.abspath(os.path.expanduser(args.runtimes_threads))
    if not os.path.isdir(os.path.join(sdk, "share", "wasi-sysroot")):
        sys.exit(f"{sdk} does not look like a wasi-sdk (no share/wasi-sysroot)")
    if not os.path.isfile(os.path.join(runtimes, "lib", "libc++.a")):
        sys.exit(f"{runtimes} has no lib/libc++.a - run tools/toolchain/build_wasm_clang.sh")

    version = clang_version(sdk)
    counts = [0, 0]
    raw = io.BytesIO()

    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for src, dst in TREES:
            src_path = os.path.join(sdk, src.format(v=version))
            if not os.path.isdir(src_path):
                sys.exit(f"missing directory: {src_path}")
            add_tree(tar, src_path, dst.format(v=version), counts)

        for src, dst in FILES:
            src_path = os.path.join(sdk, src.format(v=version, target=TARGET))
            if not os.path.isfile(src_path):
                sys.exit(f"missing file: {src_path}")
            add_file(tar, src_path, dst.format(v=version, target=TARGET))
            counts[0] += 1
            counts[1] += os.path.getsize(src_path)

        for src, dst in RUNTIME_TREES:
            src_path = os.path.join(runtimes, src)
            if not os.path.isdir(src_path):
                sys.exit(f"missing directory: {src_path}")
            add_tree(tar, src_path, dst, counts)

        for src, dst in RUNTIME_FILES:
            src_path = os.path.join(runtimes, src)
            if not os.path.isfile(src_path):
                sys.exit(f"missing file: {src_path}")
            add_file(tar, src_path, dst)
            counts[0] += 1
            counts[1] += os.path.getsize(src_path)

        # Threads headers land at include/c++/v1-threads so the compiler can be
        # pointed at one or the other.
        threads_headers = os.path.join(runtimes_threads, "include", "c++", "v1")
        if not os.path.isdir(threads_headers):
            sys.exit(f"missing directory: {threads_headers}")
        add_tree(tar, threads_headers, "include/c++/v1-threads", counts)

        for src, dst in THREAD_FILES:
            src_path = os.path.join(runtimes_threads, src)
            if not os.path.isfile(src_path):
                sys.exit(f"missing file: {src_path}")
            add_file(tar, src_path, dst)
            counts[0] += 1
            counts[1] += os.path.getsize(src_path)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "wb") as out:
        out.write(gzip.compress(raw.getvalue(), 9))

    packed = os.path.getsize(args.out)
    print(f"clang resource version: {version}")
    print(f"{counts[0]} files, {counts[1] / (1024 * 1024):.1f} MB "
          f"-> {args.out} ({packed / (1024 * 1024):.1f} MB gzipped)")


if __name__ == "__main__":
    main()
