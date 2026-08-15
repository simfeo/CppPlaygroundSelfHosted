# Ace editor (vendored)

Source: https://github.com/ajaxorg/ace — npm package `ace-builds`, version **1.44.0**
License: BSD-3-Clause, see `LICENSE` (retained verbatim, as the license requires).

Only the files the playground actually loads are kept, taken unmodified from
`src-min-noconflict/` in the published package:

| File | Purpose |
| --- | --- |
| `ace.js` | the editor itself |
| `mode-c_cpp.js` | C/C++ syntax mode |
| `theme-one_dark.js` | dark theme |
| `theme-textmate.js` | light theme |

To update, download the tarball from npm and replace these files:

    npm pack ace-builds
    tar xzf ace-builds-*.tgz
    cp package/src-min-noconflict/{ace,mode-c_cpp,theme-one_dark,theme-textmate}.js .
    cp package/LICENSE .
