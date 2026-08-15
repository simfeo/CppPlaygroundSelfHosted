#!/usr/bin/env bash
# Builds clang + wasm-ld for wasm32-wasi. Linux (WSL is fine), no Docker.
#
#   ./build_wasm_clang.sh [workdir]
#
# Needs: cmake, ninja, a C++17 host compiler, curl, tar, ~5 GB disk, ~1 h.
# Produces $WORK/out/{clang.wasm,wasm-ld.wasm} plus the wasi sysroot.
set -euo pipefail

WORK="${1:-$HOME/wasm-clang}"
LLVM_VERSION="${LLVM_VERSION:-22.1.8}"
WASI_SDK_VERSION="${WASI_SDK_VERSION:-33}"
JOBS="${JOBS:-$(nproc)}"

DL="$WORK/dl"
SDK="$WORK/wasi-sdk"
SRC="$WORK/llvm-project"
NATIVE="$WORK/build-native"
CROSS="$WORK/build-wasm"
RUNTIMES="$WORK/build-runtimes"
RUNTIMES_INSTALL="$WORK/runtimes"
RUNTIMES_THREADS="$WORK/build-runtimes-threads"
RUNTIMES_THREADS_INSTALL="$WORK/runtimes-threads"
OUT="$WORK/out"

# Standard wasm exception handling, not the legacy opcodes.
# -fdeclspec: libunwind's Unwind-wasm.c uses __declspec(...) unconditionally.
EH_FLAGS="-fwasm-exceptions -mllvm -wasm-use-legacy-eh=false -fdeclspec"

mkdir -p "$DL" "$OUT"

step() { printf '\n=== %s ===\n' "$1"; }

step "wasi-sdk $WASI_SDK_VERSION"
if [ ! -x "$SDK/bin/clang" ]; then
    base="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION}"
    [ -f "$DL/wasi-sdk.tar.gz" ] || \
        curl -fL -o "$DL/wasi-sdk.tar.gz" "$base/wasi-sdk-${WASI_SDK_VERSION}.0-x86_64-linux.tar.gz"
    mkdir -p "$SDK"
    tar xf "$DL/wasi-sdk.tar.gz" -C "$SDK" --strip-components=1
fi
"$SDK/bin/clang" --version | head -1

step "llvm-project $LLVM_VERSION source"
if [ ! -d "$SRC" ]; then
    [ -f "$DL/llvm.tar.xz" ] || curl -fL -o "$DL/llvm.tar.xz" \
        "https://github.com/llvm/llvm-project/releases/download/llvmorg-${LLVM_VERSION}/llvm-project-${LLVM_VERSION}.src.tar.xz"
    tar xf "$DL/llvm.tar.xz" -C "$WORK"
    mv "$WORK/llvm-project-${LLVM_VERSION}.src" "$SRC"
fi

step "patches"
PATCH_DIR="$(cd "$(dirname "$0")/patches" && pwd)"
for patch in "$PATCH_DIR"/*.patch; do
    name=$(basename "$patch")
    if patch -d "$SRC" -p1 -N -r - --dry-run -s -i "$patch" >/dev/null 2>&1; then
        patch -d "$SRC" -p1 -N -r - -s -i "$patch"
        echo "applied $name"
    elif patch -d "$SRC" -p1 -R --dry-run -s -i "$patch" >/dev/null 2>&1; then
        echo "already applied: $name"
    else
        echo "ERROR: $name does not apply to llvm-project $LLVM_VERSION" >&2
        exit 1
    fi
done

step "native tblgen (needed to cross-compile)"
if [ ! -x "$NATIVE/bin/clang-tblgen" ]; then
    cmake -G Ninja -S "$SRC/llvm" -B "$NATIVE" \
        -DCMAKE_BUILD_TYPE=Release \
        -DLLVM_ENABLE_PROJECTS=clang \
        -DLLVM_TARGETS_TO_BUILD=WebAssembly \
        -DLLVM_ENABLE_ZSTD=OFF \
        -DLLVM_ENABLE_LIBXML2=OFF \
        -DLLVM_INCLUDE_TESTS=OFF \
        -DLLVM_INCLUDE_BENCHMARKS=OFF \
        -DLLVM_INCLUDE_EXAMPLES=OFF
fi
ninja -C "$NATIVE" -j "$JOBS" llvm-tblgen clang-tblgen llvm-min-tblgen

step "wasi posix shim"
SHIM_SRC="$(cd "$(dirname "$0")/wasi-shim" && pwd)"
SHIM="$WORK/shim"
mkdir -p "$SHIM"
"$SDK/bin/clang" --target=wasm32-wasip1 -O2 -c \
    -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN \
    -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID \
    -I"$SHIM_SRC/include" -o "$SHIM/shim.o" "$SHIM_SRC/shim.c"
"$SDK/bin/llvm-ar" rcs "$SHIM/libwasi_shim.a" "$SHIM/shim.o"

step "libc++ / libc++abi / libunwind with standard wasm exceptions"
# wasi-sdk's prebuilt eh libraries still use the legacy EH opcodes, which
# browsers refuse to mix with the standard ones clang 22 emits. Built twice:
# once single-threaded, once with -pthread for std::thread support.
build_runtimes() {
    local target="$1" extra="$2" build_dir="$3" install_dir="$4" toolchain="$5"
    [ -f "$install_dir/lib/libc++.a" ] && return 0

    cmake -G Ninja -S "$SRC/runtimes" -B "$build_dir"         -DCMAKE_TOOLCHAIN_FILE="$toolchain"         -DWASI_SDK_PREFIX="$SDK"         -DCMAKE_SYSROOT="$SDK/share/wasi-sysroot"         -DCMAKE_INSTALL_PREFIX="$install_dir"         -DCMAKE_BUILD_TYPE=MinSizeRel         -DCMAKE_POSITION_INDEPENDENT_CODE=OFF         -DLLVM_ENABLE_RUNTIMES='libunwind;libcxxabi;libcxx'         -DCMAKE_C_FLAGS="$EH_FLAGS $extra"         -DCMAKE_CXX_FLAGS="$EH_FLAGS $extra"         -DCMAKE_ASM_FLAGS="$EH_FLAGS $extra"         -DLIBCXX_ENABLE_SHARED=OFF         -DLIBCXX_ENABLE_EXCEPTIONS=ON         -DLIBCXX_ENABLE_FILESYSTEM=ON         -DLIBCXX_ENABLE_ABI_LINKER_SCRIPT=OFF         -DLIBCXX_ENABLE_THREADS=ON         -DLIBCXX_HAS_PTHREAD_API=ON         -DLIBCXX_CXX_ABI=libcxxabi         -DLIBCXX_ABI_VERSION=2         -DLIBCXX_INCLUDE_TESTS=OFF         -DLIBCXX_INCLUDE_BENCHMARKS=OFF         -DLIBCXXABI_ENABLE_SHARED=OFF         -DLIBCXXABI_ENABLE_EXCEPTIONS=ON         -DLIBCXXABI_ENABLE_THREADS=ON         -DLIBCXXABI_HAS_PTHREAD_API=ON         -DLIBCXXABI_SILENT_TERMINATE=ON         -DLIBCXXABI_USE_LLVM_UNWINDER=ON         -DLIBUNWIND_ENABLE_SHARED=OFF         -DLIBUNWIND_ENABLE_THREADS=ON         -DLIBUNWIND_USE_COMPILER_RT=ON         -DLIBUNWIND_INCLUDE_TESTS=OFF         -DUNIX=ON
    ninja -C "$build_dir" -j "$JOBS" install

    # See wasi-shim/eh_tag.s: with standard EH nothing defines __cpp_exception.
    "$SDK/bin/clang" --target="$target" $extra -c         -o "$install_dir/lib/eh_tag.o" "$SHIM_SRC/eh_tag.s"
    "$SDK/bin/llvm-ar" r "$install_dir/lib/libunwind.a" "$install_dir/lib/eh_tag.o"
}

TOOLCHAIN_DIR="$(cd "$(dirname "$0")" && pwd)"
build_runtimes wasm32-wasip1 "" "$RUNTIMES" "$RUNTIMES_INSTALL" \
    "$SDK/share/cmake/wasi-sdk-p1.cmake"
build_runtimes wasm32-wasip1-threads "-pthread" "$RUNTIMES_THREADS" "$RUNTIMES_THREADS_INSTALL" \
    "$TOOLCHAIN_DIR/wasi-sdk-p1-threads.cmake"

step "cross-build clang + lld for wasm32-wasi"
export WASI_SDK_PREFIX="$SDK"
cmake -G Ninja -S "$SRC/llvm" -B "$CROSS" \
    -DCMAKE_TOOLCHAIN_FILE="$(cd "$(dirname "$0")" && pwd)/wasi-sdk-llvm.cmake" \
    -DWASI_SDK_PREFIX="$SDK" \
    -DUNIX=1 \
    -DCMAKE_BUILD_TYPE=MinSizeRel \
    -DLLVM_ENABLE_PROJECTS='clang;lld' \
    -DLLVM_TARGETS_TO_BUILD=WebAssembly \
    -DLLVM_DEFAULT_TARGET_TRIPLE=wasm32-wasi \
    -DLLVM_HOST_TRIPLE=wasm32-wasi \
    -DLLVM_NATIVE_TOOL_DIR="$NATIVE/bin" \
    -DLLVM_ENABLE_THREADS=OFF \
    -DLLVM_ENABLE_ZLIB=OFF \
    -DLLVM_ENABLE_ZSTD=OFF \
    -DLLVM_ENABLE_LIBXML2=OFF \
    -DLLVM_ENABLE_PIC=OFF \
    -DLLVM_ENABLE_UNWIND_TABLES=OFF \
    -DLLVM_ENABLE_CRASH_OVERRIDES=OFF \
    -DLLVM_INCLUDE_TESTS=OFF \
    -DLLVM_INCLUDE_BENCHMARKS=OFF \
    -DLLVM_INCLUDE_EXAMPLES=OFF \
    -DCLANG_ENABLE_STATIC_ANALYZER=OFF \
    -DCLANG_ENABLE_ARCMT=OFF \
    -DCMAKE_EXE_LINKER_FLAGS="-Wl,-z,stack-size=8388608 -Wl,--max-memory=4294967296 -lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lsetjmp -L$SHIM -lwasi_shim"

ninja -C "$CROSS" -j "$JOBS" clang lld

step "collect"
# Stripped and gzipped: the worker fetches the .gz and inflates it, so the size
# win does not depend on the web server negotiating content encoding.
for pair in "clang:clang.wasm" "lld:wasm-ld.wasm"; do
    src="$CROSS/bin/${pair%%:*}"
    dst="$OUT/${pair##*:}"
    cp "$src" "$dst"
    "$SDK/bin/llvm-strip" "$dst"
    gzip -9 -f -k "$dst"
done
mkdir -p "$OUT/lib"
cp "$RUNTIMES_INSTALL"/lib/libc++.a "$RUNTIMES_INSTALL"/lib/libc++abi.a \
   "$RUNTIMES_INSTALL"/lib/libunwind.a "$OUT/lib/"
ls -la "$OUT" "$OUT/lib"
