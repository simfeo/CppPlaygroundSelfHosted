/*
 * Tree-sitter based C++ highlighting for Ace.
 *
 * Ace's own C/C++ mode is regex-based: every identifier looks the same to it,
 * so types, calls, members and variables cannot be told apart. Tree-sitter
 * parses the code for real, and a highlight query maps syntax nodes to token
 * names, which is what makes `std::string` a type and `getline` a call.
 *
 * Loaded as a module and applied on top of Ace's mode once ready, so the editor
 * works (with basic highlighting) even if this never loads.
 */
import { Parser, Language, Query } from '../vendor/tree-sitter/web-tree-sitter.js';

const BASE = 'vendor/tree-sitter/';

// tree-sitter capture name -> Ace token type. Ace turns "entity.name.function"
// into the classes ace_entity ace_name ace_function, which the theme colours.
const TOKEN_TYPES = {
  'keyword': 'keyword',
  'keyword.control': 'keyword.control',
  'keyword.preproc': 'keyword.preproc',
  'type': 'support.type',
  'type.builtin': 'storage.type',
  'namespace': 'entity.name.namespace',
  'function': 'entity.name.function',
  'function.special': 'entity.name.function',
  'property': 'variable.property',
  'variable': 'variable',
  'variable.builtin': 'variable.language',
  'variable.parameter': 'variable.parameter',
  'constant': 'constant.language',
  'constant.macro': 'constant.macro',
  'number': 'constant.numeric',
  'string': 'string',
  'comment': 'comment',
  'operator': 'keyword.operator',
  'delimiter': 'punctuation.operator',
  'label': 'entity.name.label',
};

async function text(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

class CppHighlighter {
  constructor(language, query) {
    this.language = language;
    this.query = query;
    this.parser = new Parser();
    this.parser.setLanguage(language);
    this.tree = null;
    this.lines = [];      // per row: [{type, value}, ...]
    this.lineText = [];   // the text each row was built from
  }

  /* Parses the document and rebuilds the per-line token cache.
   *
   * Deliberately a full reparse. Passing the previous tree only works if it has
   * been told about each edit via tree.edit(); handing over a stale tree instead
   * yields silently wrong node positions. Playground files are small enough that
   * parsing from scratch is immeasurable. */
  update(source) {
    const tree = this.parser.parse(source);
    if (this.tree) this.tree.delete();
    this.tree = tree;

    // Paint captures onto the character range they cover. Larger spans go down
    // first so that nested, more specific captures overwrite them; equal spans
    // keep the later capture, which is how our extra query refines the stock one.
    const owner = new Int32Array(source.length).fill(-1);
    const captures = this.query.captures(tree.rootNode);
    const ordered = captures.map((c, index) => ({
      index,
      name: c.name,
      start: c.node.startIndex,
      end: c.node.endIndex,
    })).sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.index - b.index);

    const names = [];
    for (const capture of ordered) {
      const type = TOKEN_TYPES[capture.name]
        || TOKEN_TYPES[capture.name.split('.')[0]];
      if (!type) continue;
      const id = names.push(type) - 1;
      owner.fill(id, capture.start, Math.min(capture.end, source.length));
    }

    this.lines = [];
    this.lineText = [];
    let offset = 0;
    for (const line of source.split('\n')) {
      this.lines.push(this.tokensFor(owner, names, offset, line));
      this.lineText.push(line);
      offset += line.length + 1;
    }
  }

  tokensFor(owner, names, offset, line) {
    const tokens = [];
    let runStart = 0;
    let runId = line.length ? owner[offset] : -1;
    for (let i = 1; i <= line.length; i++) {
      const id = i < line.length ? owner[offset + i] : -2;
      if (id === runId) continue;
      tokens.push({
        type: runId >= 0 ? names[runId] : 'text',
        value: line.slice(runStart, i),
      });
      runStart = i;
      runId = id;
    }
    return tokens.length ? tokens : [{ type: 'text', value: line }];
  }

  /* An Ace tokenizer backed by the cache. Ace passes the line it is about to
   * render; if it does not match what we parsed, the cache is mid-update and
   * plain text is the honest answer for one frame. */
  tokenizer() {
    const self = this;
    return {
      getLineTokens(line, state, row) {
        const cached = self.lines[row];
        if (cached && self.lineText[row] === line) return { tokens: cached, state: null };
        return { tokens: [{ type: 'text', value: line }], state: null };
      },
    };
  }
}

async function create() {
  await Parser.init({
    locateFile: name => BASE + name,
  });
  const language = await Language.load(BASE + 'tree-sitter-cpp.wasm');
  const source = (await Promise.all([
    text(BASE + 'queries/c.scm'),
    text(BASE + 'queries/cpp.scm'),
    text('queries/cpp-extra.scm'),
  ])).join('\n');
  return new CppHighlighter(language, new Query(language, source));
}

window.cppHighlighterReady = create().then(highlighter => {
  window.cppHighlighter = highlighter;
  window.dispatchEvent(new CustomEvent('cpp-highlighter-ready'));
  return highlighter;
}).catch(error => {
  console.warn('tree-sitter highlighting unavailable, keeping Ace\'s own mode:', error);
  return null;
});
