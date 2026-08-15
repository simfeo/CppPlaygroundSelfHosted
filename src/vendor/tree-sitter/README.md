# Tree-sitter (vendored)

Real C++ parsing for syntax highlighting. Ace's own C/C++ mode is regex-based
and cannot tell a type from a call from a variable; Tree-sitter builds a syntax
tree, and `src/js/ts-highlight.js` maps its nodes onto Ace token types.

| File | Source | Version | License |
| --- | --- | --- | --- |
| `web-tree-sitter.js`, `web-tree-sitter.wasm` | npm `web-tree-sitter` | 0.26.12 | MIT (`LICENSE.web-tree-sitter`) |
| `tree-sitter-cpp.wasm` | npm `tree-sitter-cpp` | 0.23.4 | MIT (`LICENSE.tree-sitter-cpp`) |
| `queries/cpp.scm` | npm `tree-sitter-cpp`, `queries/highlights.scm` | 0.23.4 | MIT |
| `queries/c.scm` | npm `tree-sitter-c`, `queries/highlights.scm` | latest | MIT |

The grammar wasm is prebuilt in the npm package, so updating needs no emscripten
and no Tree-sitter CLI:

    npm pack web-tree-sitter tree-sitter-cpp tree-sitter-c
    # web-tree-sitter.js, web-tree-sitter.wasm, tree-sitter-cpp.wasm,
    # and the two queries/highlights.scm files

The C++ query only covers what C++ adds, so the C query is loaded alongside it.
Our own refinements live outside this directory, in `src/queries/cpp-extra.scm`.
