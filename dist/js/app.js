/* UI: file tree, editor, console, zip export. */
(function () {
  'use strict';

  const STORAGE_KEY = 'cpp-playground.state.v1';

  const DEFAULT_STATE = {
    project: 'playground',
    std: 'c++17',
    opt: '2',
    flags: '',
    stdin: '',
    active: 'main.cpp',
    files: [
      {
        path: 'main.cpp',
        content: `#include <iostream>
#include <string>
#include "greeting.h"

int main() {
    std::string name;
    std::cout << "What is your name? ";
    std::getline(std::cin, name);
    if (name.empty()) name = "world";
    std::cout << greeting(name) << '\\n';
}
`
      },
      {
        path: 'greeting.h',
        content: `#pragma once
#include <string>

inline std::string greeting(const std::string& who) {
    return "Hello, " + who + "!";
}
`
      }
    ]
  };

  const $ = id => document.getElementById(id);
  const el = {
    run: $('btnRun'), zip: $('btnZip'), reset: $('btnReset'), clear: $('btnClear'),
    newFile: $('btnNewFile'), fileList: $('fileList'), tabs: $('tabs'),
    editor: $('editor'), gutter: $('gutter'), console: $('console'), stdin: $('stdin'),
    std: $('selStd'), opt: $('selOpt'), flags: $('txtFlags'), project: $('txtProject'),
    status: $('status'),
  };

  let state = load();
  let worker = null;
  let running = false;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && Array.isArray(s.files) && s.files.length) return s;
      }
    } catch (e) { /* fall through to defaults */ }
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
  }

  function file(path) { return state.files.find(f => f.path === path); }

  function activeFile() {
    return file(state.active) || state.files[0];
  }

  /* ---------- rendering ---------- */

  function renderFiles() {
    el.fileList.innerHTML = '';
    el.tabs.innerHTML = '';
    const active = activeFile();
    state.active = active.path;

    for (const f of [...state.files].sort((a, b) => a.path.localeCompare(b.path))) {
      const li = document.createElement('li');
      if (f.path === state.active) li.className = 'active';
      const name = document.createElement('span');
      name.textContent = f.path;
      li.appendChild(name);

      const ren = document.createElement('button');
      ren.textContent = '✎';
      ren.title = 'Rename';
      ren.onclick = e => { e.stopPropagation(); renameFile(f.path); };
      li.appendChild(ren);

      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Delete';
      del.onclick = e => { e.stopPropagation(); deleteFile(f.path); };
      li.appendChild(del);

      li.onclick = () => selectFile(f.path);
      el.fileList.appendChild(li);

      const tab = document.createElement('div');
      tab.className = 'tab' + (f.path === state.active ? ' active' : '');
      tab.textContent = f.path;
      tab.onclick = () => selectFile(f.path);
      el.tabs.appendChild(tab);
    }

    el.editor.value = active.content;
    renderGutter();
  }

  function renderGutter() {
    const lines = el.editor.value.split('\n').length;
    let s = '';
    for (let i = 1; i <= lines; i++) s += i + '\n';
    el.gutter.textContent = s;
    el.gutter.scrollTop = el.editor.scrollTop;
  }

  function selectFile(path) {
    activeFile().content = el.editor.value;
    state.active = path;
    save();
    renderFiles();
    el.editor.focus();
  }

  function newFile() {
    const path = prompt('New file path (e.g. src/util.cpp):', 'util.cpp');
    if (!path) return;
    const clean = path.trim().replace(/^[./\\]+/, '').replace(/\\/g, '/');
    if (!clean) return;
    if (file(clean)) { alert('A file with that path already exists.'); return; }
    activeFile().content = el.editor.value;
    state.files.push({ path: clean, content: '' });
    state.active = clean;
    save();
    renderFiles();
  }

  function renameFile(path) {
    const next = prompt('Rename file:', path);
    if (!next) return;
    const clean = next.trim().replace(/^[./\\]+/, '').replace(/\\/g, '/');
    if (!clean || clean === path) return;
    if (file(clean)) { alert('A file with that path already exists.'); return; }
    activeFile().content = el.editor.value;
    file(path).path = clean;
    if (state.active === path) state.active = clean;
    save();
    renderFiles();
  }

  function deleteFile(path) {
    if (state.files.length === 1) { alert('The project needs at least one file.'); return; }
    if (!confirm(`Delete ${path}?`)) return;
    state.files = state.files.filter(f => f.path !== path);
    if (state.active === path) state.active = state.files[0].path;
    save();
    renderFiles();
  }

  /* ---------- console ---------- */

  const ANSI = /\x1b\[([0-9;]*)m/g;

  function appendOutput(text) {
    // Translate the SGR subset clang emits into spans; drop everything else.
    const atBottom = el.console.scrollTop + el.console.clientHeight >= el.console.scrollHeight - 4;
    let last = 0, match;
    let classes = [];
    ANSI.lastIndex = 0;
    while ((match = ANSI.exec(text)) !== null) {
      emit(text.slice(last, match.index), classes);
      classes = sgrToClasses(match[1], classes);
      last = ANSI.lastIndex;
    }
    emit(text.slice(last), classes);
    if (atBottom) el.console.scrollTop = el.console.scrollHeight;
  }

  function sgrToClasses(param, current) {
    const codes = param.split(';').filter(s => s !== '').map(Number);
    if (codes.length === 0 || codes.includes(0)) return [];
    const next = current.slice();
    for (const c of codes) {
      if (c === 1) next.push('bold');
      else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) {
        const i = next.findIndex(x => /^a\d+$/.test(x));
        if (i >= 0) next.splice(i, 1);
        next.push('a' + c);
      }
    }
    return [...new Set(next)];
  }

  function emit(text, classes) {
    if (!text) return;
    if (classes.length === 0) {
      el.console.appendChild(document.createTextNode(text));
    } else {
      const span = document.createElement('span');
      span.className = classes.join(' ');
      span.textContent = text;
      el.console.appendChild(span);
    }
  }

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  /* ---------- build & run ---------- */

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('js/worker.js');
    worker.onmessage = event => {
      const { id, data } = event.data;
      if (id === 'write') {
        appendOutput(data);
      } else if (id === 'done') {
        running = false;
        el.run.disabled = false;
        if (data.ok) {
          setStatus('finished', 'ok');
        } else {
          setStatus('failed', 'err');
          // clang/lld already printed their diagnostics and the exit message.
          if (!/^process exited with code/.test(data.message)) {
            appendOutput(`\n\x1b[91m${data.message}\x1b[0m\n`);
          }
        }
      }
    };
    worker.onerror = e => {
      running = false;
      el.run.disabled = false;
      setStatus('worker error', 'err');
      appendOutput(`\n\x1b[91mWorker error: ${e.message}\x1b[0m\n`);
    };
    return worker;
  }

  function run() {
    if (running) return;
    activeFile().content = el.editor.value;
    collectOptions();
    save();

    running = true;
    el.run.disabled = true;
    el.console.textContent = '';
    setStatus('building…', 'busy');

    ensureWorker().postMessage({
      id: 'run',
      data: {
        files: state.files.map(f => ({ path: f.path, content: f.content })),
        stdin: state.stdin,
        options: { std: state.std, opt: state.opt, flags: state.flags },
      }
    });
  }

  function collectOptions() {
    state.std = el.std.value;
    state.opt = el.opt.value;
    state.flags = el.flags.value;
    state.stdin = el.stdin.value;
    state.project = el.project.value.trim() || 'playground';
  }

  /* ---------- export ---------- */

  function downloadZip() {
    activeFile().content = el.editor.value;
    collectOptions();
    save();

    const root = sanitizeTarget(state.project);
    const entries = state.files.map(f => ({ name: `${root}/${f.path}`, data: f.content }));
    entries.push({ name: `${root}/CMakeLists.txt`, data: generateCMakeLists(state.files, state) });
    entries.push({ name: `${root}/README.md`, data: generateReadme(state) });

    const url = URL.createObjectURL(makeZip(entries));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${root}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  /* ---------- wiring ---------- */

  el.editor.addEventListener('input', () => {
    activeFile().content = el.editor.value;
    renderGutter();
    save();
  });
  el.editor.addEventListener('scroll', () => { el.gutter.scrollTop = el.editor.scrollTop; });
  el.editor.addEventListener('keydown', e => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = el.editor.selectionStart, end = el.editor.selectionEnd;
      el.editor.setRangeText('    ', start, end, 'end');
      el.editor.dispatchEvent(new Event('input'));
    }
  });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
  });

  el.run.onclick = run;
  el.zip.onclick = downloadZip;
  el.newFile.onclick = newFile;
  el.clear.onclick = () => { el.console.textContent = ''; setStatus('idle'); };
  el.reset.onclick = () => {
    if (!confirm('Discard the current project and restore the example?')) return;
    state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    save();
    init();
  };
  for (const node of [el.std, el.opt, el.flags, el.stdin, el.project]) {
    node.addEventListener('change', () => { collectOptions(); save(); });
  }

  function init() {
    el.std.value = state.std;
    el.opt.value = state.opt;
    el.flags.value = state.flags;
    el.stdin.value = state.stdin;
    el.project.value = state.project;
    renderFiles();
    setStatus('idle');
  }

  init();
})();
