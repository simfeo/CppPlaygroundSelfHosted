# Defines the C++ exception tag.
#
# With the legacy exception opcodes, libunwind's Unwind-wasm.c ended up defining
# __cpp_exception itself, so wasi-sdk's prebuilt libunwind.a carries it. With the
# standardized opcodes every object only imports the tag and nothing defines it,
# so linking any program that throws fails with "undefined symbol:
# __cpp_exception". A tag can only be defined in assembly, hence this file; it is
# archived into our libunwind.a.

	.tagtype	__cpp_exception i32
	.globl	__cpp_exception
__cpp_exception:
