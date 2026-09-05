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

/*
 * The debugger's stop point.
 *
 * dbgrewrite.js splices "i32.const <id>; call __dbg_line" into the linked
 * module at the code offset of every user source line. That works only because
 * this function is already defined here at link time: adding an import to a
 * finished module would shift every function index in it, and with them every
 * call, table entry and name-section record. A defined function costs one
 * export and shifts nothing.
 */
__attribute__((import_module("playground"), import_name("on_line")))
void playground_on_line(unsigned id, unsigned frame);

/*
 * `frame` is the function's own frame base, which the rewriter loads from the
 * wasm local DWARF names in DW_AT_frame_base and passes in. It has to arrive
 * this way: locations are DW_OP_fbreg offsets from that base, and a wasm local
 * is not something a JavaScript host can read out of a live frame.
 */
void __dbg_line(unsigned id, unsigned frame) { playground_on_line(id, frame); }

__attribute__((import_module("playground"), import_name("on_local")))
void playground_on_local(unsigned slot, unsigned value);

/*
 * Some variables are not at an offset from the frame base but at an address
 * held in a wasm local: a struct passed by value is described as
 * DW_OP_WASM_location <local>, with no DW_OP_stack_value, meaning the local
 * holds where the object is rather than what it is. The rewriter emits one call
 * to this per such local, just before the __dbg_line for that source line.
 */
void __dbg_local(unsigned slot, unsigned value) { playground_on_local(slot, value); }

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
