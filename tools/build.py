"""Refreshes dist/ from src/.

dist/ is committed to the repository, toolchain binaries and all, so that a
clone can be served straight away without building anything. This script only
matters when you edit src/: it copies the app files over the ones in dist/ and
leaves dist/vendor/ alone.

    python tools/build.py

Pass --toolchain to also replace the compiler binaries, e.g. after rebuilding
them with tools/toolchain/build_wasm_clang.sh:

    python tools/build.py --toolchain ~/wasm-clang/out
"""

import argparse
import os
import shutil
import sys

VENDOR_ASSETS = ["clang.wasm.gz", "wasm-ld.wasm.gz", "sysroot.tar.gz"]


def dir_size(path):
    total = 0
    for root, _, files in os.walk(path):
        for name in files:
            total += os.path.getsize(os.path.join(root, name))
    return total


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.abspath(os.path.join(here, ".."))

    parser = argparse.ArgumentParser(prog="build", description="Refresh dist/ from src/")
    parser.add_argument("-o", "--out_dir", default=os.path.join(root, "dist"),
                        help="output directory (default: dist/)")
    parser.add_argument("-t", "--toolchain",
                        help="directory holding freshly built clang.wasm.gz, wasm-ld.wasm.gz "
                             "and sysroot.tar.gz; omit to keep the ones already in dist/vendor/")
    args = parser.parse_args()

    src = os.path.join(root, "src")
    out = os.path.abspath(args.out_dir)
    vendor_out = os.path.join(out, "vendor")

    toolchain = os.path.abspath(os.path.expanduser(args.toolchain)) if args.toolchain else None
    if toolchain:
        missing = [a for a in VENDOR_ASSETS if not os.path.isfile(os.path.join(toolchain, a))]
        if missing:
            sys.exit(f"{toolchain} is missing {', '.join(missing)}.\n"
                     "Build them with tools/toolchain/build_wasm_clang.sh and "
                     "tools/pack_sysroot.py.")

    # Replace the app files without touching vendor/ - those binaries are large,
    # come from a separate build, and are what makes a fresh clone runnable.
    for name in os.listdir(src):
        source = os.path.join(src, name)
        target = os.path.join(out, name)
        if os.path.isdir(source):
            shutil.rmtree(target, ignore_errors=True)
            shutil.copytree(source, target)
        else:
            os.makedirs(out, exist_ok=True)
            shutil.copyfile(source, target)

    os.makedirs(vendor_out, exist_ok=True)
    if toolchain:
        for asset in VENDOR_ASSETS:
            shutil.copyfile(os.path.join(toolchain, asset), os.path.join(vendor_out, asset))

    absent = [a for a in VENDOR_ASSETS if not os.path.isfile(os.path.join(vendor_out, a))]
    if absent:
        print(f"warning: {vendor_out} is missing {', '.join(absent)} - the playground "
              "will not compile anything until they are built and installed with "
              "--toolchain", file=sys.stderr)

    print(f"built {out} ({dir_size(out) / (1024 * 1024):.1f} MB)")


if __name__ == "__main__":
    main()
