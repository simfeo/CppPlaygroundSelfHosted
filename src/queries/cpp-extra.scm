; Additions to the upstream tree-sitter C/C++ highlight queries, for the
; distinctions Visual Studio / VS Code make but the stock queries do not:
; namespaces, types, member functions, parameters and macros.
;
; Applied after the vendored queries; on equal-sized matches the later capture
; wins, so these refine rather than fight the upstream rules.

; Control flow reads differently from declaration keywords in VS Code.
[
  "if" "else" "for" "while" "do" "switch" "case" "default"
  "break" "continue" "return" "goto"
] @keyword.control

; Types
(type_identifier) @type
(primitive_type) @type.builtin
(sized_type_specifier) @type.builtin
(namespace_identifier) @namespace

; Members first, so that the call rules below win on the same node: `s.empty()`
; should read as a call, not a field.
(field_identifier) @property

; Functions: calls, definitions and members
(call_expression
  function: (identifier) @function)
(call_expression
  function: (field_expression
    field: (field_identifier) @function))
(function_declarator
  declarator: (identifier) @function)
; Method declarations name themselves with a field_identifier, which the rule
; above would otherwise leave looking like a data member.
(function_declarator
  declarator: (field_identifier) @function)

; Character literals are strings, not numbers
(char_literal) @string

; Parameters
(parameter_declaration
  declarator: (identifier) @variable.parameter)
(parameter_declaration
  declarator: (pointer_declarator
    declarator: (identifier) @variable.parameter))
(parameter_declaration
  declarator: (reference_declarator
    (identifier) @variable.parameter))

; Preprocessor
(preproc_include
  path: (string_literal) @string)
(preproc_include
  path: (system_lib_string) @string)
(preproc_def
  name: (identifier) @constant.macro)
(preproc_function_def
  name: (identifier) @constant.macro)
