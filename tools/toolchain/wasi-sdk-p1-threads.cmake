# wasi-sdk toolchain for wasm32-wasip1-threads.
#
# wasi-sdk ships share/cmake/wasi-sdk-pthread.cmake, but it targets the
# deprecated wasm32-wasi-threads triple. Everything here uses wasm32-wasip1-threads
# so the runtime libraries match what the playground compiles user code with.

if(NOT WASI_SDK_PREFIX)
    set(WASI_SDK_PREFIX "$ENV{WASI_SDK_PREFIX}")
endif()
if(NOT WASI_SDK_PREFIX)
    message(FATAL_ERROR "set WASI_SDK_PREFIX (env or -D) to the wasi-sdk path")
endif()

set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(triple wasm32-wasip1-threads)

set(CMAKE_C_COMPILER ${WASI_SDK_PREFIX}/bin/clang)
set(CMAKE_CXX_COMPILER ${WASI_SDK_PREFIX}/bin/clang++)
set(CMAKE_ASM_COMPILER ${WASI_SDK_PREFIX}/bin/clang)
set(CMAKE_AR ${WASI_SDK_PREFIX}/bin/llvm-ar)
set(CMAKE_RANLIB ${WASI_SDK_PREFIX}/bin/llvm-ranlib)
set(CMAKE_C_COMPILER_TARGET ${triple})
set(CMAKE_CXX_COMPILER_TARGET ${triple})
set(CMAKE_ASM_COMPILER_TARGET ${triple})

set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -pthread")
set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -pthread")

# wasi-threads needs every thread to instantiate against one shared memory:
# --import-memory makes the module take it from the host, --export-memory keeps
# it visible (implicit only when --import-memory is absent).
set(CMAKE_EXE_LINKER_FLAGS "${CMAKE_EXE_LINKER_FLAGS} -Wl,--import-memory -Wl,--export-memory")

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
