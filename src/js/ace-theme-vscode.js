/*
 * VS Code "Dark+" colours as an Ace theme.
 *
 * Ace ships no theme resembling VS Code, so this maps the token types its C/C++
 * mode actually emits onto the Dark+ palette. Token names were taken from the
 * mode itself, not guessed: keyword (preprocessor directives), keyword.control,
 * storage.type, storage.modifier, constant.other (include targets), and so on.
 */
ace.define("ace/theme/vscode_dark", ["require", "exports", "module", "ace/lib/dom"],
  function (require, exports, module) {
    exports.isDark = true;
    exports.cssClass = "ace-vscode-dark";
    exports.cssText = `
.ace-vscode-dark {
  background-color: #1f1f1f;
  color: #d4d4d4;
}
.ace-vscode-dark .ace_gutter {
  background: #1f1f1f;
  color: #6e7681;
  border-right: 1px solid #2b2b2b;
}
.ace-vscode-dark .ace_gutter-active-line { background-color: #2a2d2e; color: #cccccc; }
.ace-vscode-dark .ace_fold { background-color: #569cd6; }
.ace-vscode-dark .ace_cursor { color: #aeafad; }
.ace-vscode-dark .ace_marker-layer .ace_selection { background: #264f78; }
.ace-vscode-dark.ace_multiselect .ace_selection.ace_start { box-shadow: 0 0 3px 0 #1f1f1f; }
.ace-vscode-dark .ace_marker-layer .ace_active-line { background: #2a2d2e; }
.ace-vscode-dark .ace_marker-layer .ace_selected-word { border: 1px solid #264f78; }
.ace-vscode-dark .ace_marker-layer .ace_bracket { border: 1px solid #888888; }
.ace-vscode-dark .ace_indent-guide {
  background: linear-gradient(to right, #404040 0 1px, transparent 1px);
}
.ace-vscode-dark .ace_print-margin { width: 1px; background: #2b2b2b; }
.ace-vscode-dark .ace_invisible { color: #404040; }

/* Comments and strings */
.ace-vscode-dark .ace_comment { color: #6a9955; }
.ace-vscode-dark .ace_string { color: #ce9178; }
.ace-vscode-dark .ace_constant.ace_language.ace_escape { color: #d7ba7d; }

/* Numbers and language constants */
.ace-vscode-dark .ace_constant.ace_numeric { color: #b5cea8; }
.ace-vscode-dark .ace_constant.ace_language { color: #569cd6; }

/* Preprocessor: #include / #define are magenta, the target reads as a string */
.ace-vscode-dark .ace_keyword { color: #c586c0; }
.ace-vscode-dark .ace_constant.ace_other { color: #ce9178; }

/* Control flow keeps the magenta; types and modifiers are blue */
.ace-vscode-dark .ace_keyword.ace_control { color: #c586c0; }
.ace-vscode-dark .ace_storage,
.ace-vscode-dark .ace_storage.ace_type,
.ace-vscode-dark .ace_storage.ace_modifier { color: #569cd6; }
.ace-vscode-dark .ace_support.ace_type,
.ace-vscode-dark .ace_entity.ace_name.ace_type { color: #4ec9b0; }
.ace-vscode-dark .ace_support.ace_function,
.ace-vscode-dark .ace_entity.ace_name.ace_function { color: #dcdcaa; }

/* Tree-sitter token types: namespaces, members, parameters, macros */
.ace-vscode-dark .ace_entity.ace_name.ace_namespace { color: #4ec9b0; }
.ace-vscode-dark .ace_variable.ace_property { color: #9cdcfe; }
.ace-vscode-dark .ace_variable.ace_parameter { color: #9cdcfe; }
.ace-vscode-dark .ace_variable.ace_language { color: #569cd6; }
.ace-vscode-dark .ace_constant.ace_macro { color: #beb7ff; }
.ace-vscode-dark .ace_keyword.ace_preproc { color: #c586c0; }
.ace-vscode-dark .ace_entity.ace_name.ace_label { color: #c8c8c8; }

/* Identifiers, operators and punctuation */
.ace-vscode-dark .ace_identifier { color: #9cdcfe; }
.ace-vscode-dark .ace_variable { color: #9cdcfe; }
.ace-vscode-dark .ace_keyword.ace_operator,
.ace-vscode-dark .ace_punctuation,
.ace-vscode-dark .ace_punctuation.ace_operator,
.ace-vscode-dark .ace_paren { color: #d4d4d4; }
`;
    require("../lib/dom").importCssString(exports.cssText, exports.cssClass, false);
  });

/* The same mapping in VS Code's "Light+" colours. */
ace.define("ace/theme/vscode_light", ["require", "exports", "module", "ace/lib/dom"],
  function (require, exports, module) {
    exports.isDark = false;
    exports.cssClass = "ace-vscode-light";
    exports.cssText = `
.ace-vscode-light {
  background-color: #ffffff;
  color: #3b3b3b;
}
.ace-vscode-light .ace_gutter {
  background: #ffffff;
  color: #6e7681;
  border-right: 1px solid #e5e5e5;
}
.ace-vscode-light .ace_gutter-active-line { background-color: #f0f0f0; color: #333333; }
.ace-vscode-light .ace_fold { background-color: #0000ff; }
.ace-vscode-light .ace_cursor { color: #000000; }
.ace-vscode-light .ace_marker-layer .ace_selection { background: #add6ff; }
.ace-vscode-light.ace_multiselect .ace_selection.ace_start { box-shadow: 0 0 3px 0 #ffffff; }
.ace-vscode-light .ace_marker-layer .ace_active-line { background: #f0f0f0; }
.ace-vscode-light .ace_marker-layer .ace_selected-word { border: 1px solid #add6ff; }
.ace-vscode-light .ace_marker-layer .ace_bracket { border: 1px solid #b9b9b9; }
.ace-vscode-light .ace_indent-guide {
  background: linear-gradient(to right, #d3d3d3 0 1px, transparent 1px);
}
.ace-vscode-light .ace_print-margin { width: 1px; background: #e5e5e5; }
.ace-vscode-light .ace_invisible { color: #d3d3d3; }

.ace-vscode-light .ace_comment { color: #008000; }
.ace-vscode-light .ace_string { color: #a31515; }
.ace-vscode-light .ace_constant.ace_language.ace_escape { color: #ee0000; }

.ace-vscode-light .ace_constant.ace_numeric { color: #098658; }
.ace-vscode-light .ace_constant.ace_language { color: #0000ff; }

.ace-vscode-light .ace_keyword { color: #af00db; }
.ace-vscode-light .ace_constant.ace_other { color: #a31515; }

.ace-vscode-light .ace_keyword.ace_control { color: #af00db; }
.ace-vscode-light .ace_storage,
.ace-vscode-light .ace_storage.ace_type,
.ace-vscode-light .ace_storage.ace_modifier { color: #0000ff; }
.ace-vscode-light .ace_support.ace_type,
.ace-vscode-light .ace_entity.ace_name.ace_type { color: #267f99; }
.ace-vscode-light .ace_support.ace_function,
.ace-vscode-light .ace_entity.ace_name.ace_function { color: #795e26; }

.ace-vscode-light .ace_entity.ace_name.ace_namespace { color: #267f99; }
.ace-vscode-light .ace_variable.ace_property { color: #001080; }
.ace-vscode-light .ace_variable.ace_parameter { color: #001080; }
.ace-vscode-light .ace_variable.ace_language { color: #0000ff; }
.ace-vscode-light .ace_constant.ace_macro { color: #0000ff; }
.ace-vscode-light .ace_keyword.ace_preproc { color: #af00db; }
.ace-vscode-light .ace_entity.ace_name.ace_label { color: #3b3b3b; }

.ace-vscode-light .ace_identifier { color: #001080; }
.ace-vscode-light .ace_variable { color: #001080; }
.ace-vscode-light .ace_keyword.ace_operator,
.ace-vscode-light .ace_punctuation,
.ace-vscode-light .ace_punctuation.ace_operator,
.ace-vscode-light .ace_paren { color: #3b3b3b; }
`;
    require("../lib/dom").importCssString(exports.cssText, exports.cssClass, false);
  });

(function () {
  ace.require(["ace/theme/vscode_dark", "ace/theme/vscode_light"], function (m) {
    if (typeof module === "object" && typeof exports === "object" && module) {
      module.exports = m;
    }
  });
})();
