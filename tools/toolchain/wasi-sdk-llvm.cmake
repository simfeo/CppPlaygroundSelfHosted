# wasi-sdk toolchain + the bits LLVM's build system expects.
#
# LLVM's HandleLLVMOptions.cmake only knows WIN32 / UNIX / Generic and errors out
# with "Unable to determine platform" on CMAKE_SYSTEM_NAME=WASI. WASI is
# POSIX-shaped, so declaring UNIX is the right answer.

# try_compile sub-projects don't inherit cache entries, so fall back to the
# environment, which they do inherit.
if(NOT WASI_SDK_PREFIX)
    set(WASI_SDK_PREFIX "$ENV{WASI_SDK_PREFIX}")
endif()
if(NOT WASI_SDK_PREFIX)
    message(FATAL_ERROR "set WASI_SDK_PREFIX (env or -D) to the wasi-sdk path")
endif()

include("${WASI_SDK_PREFIX}/share/cmake/wasi-sdk-p1.cmake")

set(UNIX 1)

# llvm/ADT/bit.h falls through to <machine/endian.h> on any platform it doesn't
# recognise; wasi-libc has no such header. Values match musl's endian.h.
set(_wasi_endian "-DBYTE_ORDER=1234 -DLITTLE_ENDIAN=1234 -DBIG_ENDIAN=4321")

# wasi-libc gates these behind opt-in macros; LLVM uses all of them
# (CrashRecoveryContext wants signals and setjmp, the allocators want mmap).
set(_wasi_emulation "-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID")

# setjmp/longjmp on wasm lowers through the exception-handling proposal.
set(_wasi_sjlj "-mllvm -wasm-enable-sjlj")

# Missing POSIX headers and failing stubs for calls wasi-libc lacks entirely
# (fork/exec, sigaction, rlimits, sockets). See wasi-shim/wasi_posix_shim.h.
set(_wasi_shim_dir "${CMAKE_CURRENT_LIST_DIR}/wasi-shim")
set(_wasi_shim "-I${_wasi_shim_dir}/include -include wasi_posix_shim.h")

set(CMAKE_C_FLAGS_INIT "${_wasi_endian} ${_wasi_emulation} ${_wasi_sjlj} ${_wasi_shim}")
set(CMAKE_CXX_FLAGS_INIT "${_wasi_endian} ${_wasi_emulation} ${_wasi_sjlj} ${_wasi_shim}")
