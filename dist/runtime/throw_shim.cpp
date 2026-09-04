/*
 * Linked into every program the playground builds, with --wrap=__cxa_throw.
 *
 * An uncaught exception is the one crash that reaches the host with nothing
 * useful attached: with -fwasm-exceptions it unwinds straight out of the
 * module, and the WebAssembly.Exception that arrives in JS carries no stack.
 * By then the frames are gone. The fix is to look earlier - this wrapper sits
 * in the throwing function's own frame, so reporting from here leaves the call
 * chain that produced the throw standing and visible to Error.stack.
 *
 * Every throw is reported, including the ones the program goes on to catch.
 * The JS side keeps only the most recent and prints it if, and only if, the
 * exception ends up escaping main.
 */

#include <exception>
#include <typeinfo>

extern "C" {

void __real___cxa_throw(void *object, void *type, void (*destructor)(void *));

__attribute__((import_module("playground"), import_name("on_throw")))
void playground_on_throw(const char *type, const char *what);

// Reporting from the catch rather than before the real throw is what gets
// what(): the alternative is reading the exception object through its type
// info by hand, and that means hard-coding libc++abi's layout. Only
// __real___cxa_throw's frame is unwound to get here, so the stack this leaves
// for the host is the same one the throw site had.
void __wrap___cxa_throw(void *object, void *type, void (*destructor)(void *)) {
    const std::type_info *info = static_cast<const std::type_info *>(type);
    const char *name = info ? info->name() : "";
    try {
        __real___cxa_throw(object, type, destructor);
    } catch (const std::exception &e) {
        playground_on_throw(name, e.what());
        throw;
    } catch (...) {
        playground_on_throw(name, "");
        throw;
    }
}

}
