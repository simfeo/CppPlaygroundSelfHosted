/* Generates a real, buildable CMakeLists.txt for an exported project. */
(function (global) {
  'use strict';

  const SOURCE_EXT = /\.(c|cc|cpp|cxx|c\+\+)$/i;

  function sanitizeTarget(name) {
    const t = name.trim().replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    return t || 'app';
  }

  function splitFlags(str) {
    return (str || '').trim().split(/\s+/).filter(Boolean);
  }

  // files: [{path, content}], opts: {project, std, opt, flags}
  function generateCMakeLists(files, opts) {
    const target = sanitizeTarget(opts.project);
    const sources = files.map(f => f.path).filter(p => SOURCE_EXT.test(p)).sort();
    const hasC = sources.some(p => /\.c$/i.test(p));
    const langs = hasC ? 'C CXX' : 'CXX';
    const stdNum = (opts.std || 'c++17').replace('c++', '');
    const dirs = [...new Set(files.map(f => f.path.includes('/') ? f.path.replace(/\/[^/]*$/, '') : '.'))].sort();

    const extra = splitFlags(opts.flags);

    const L = [];
    L.push('cmake_minimum_required(VERSION 3.16)');
    L.push(`project(${target} LANGUAGES ${langs})`);
    L.push('');
    L.push(`set(CMAKE_CXX_STANDARD ${stdNum})`);
    L.push('set(CMAKE_CXX_STANDARD_REQUIRED ON)');
    L.push('set(CMAKE_CXX_EXTENSIONS OFF)');
    L.push('');
    L.push('if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)');
    L.push('  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)');
    L.push('endif()');
    L.push('');
    L.push(`add_executable(${target}`);
    for (const s of sources) L.push(`    ${s}`);
    L.push(')');
    L.push('');
    L.push(`target_include_directories(${target} PRIVATE`);
    for (const d of dirs) L.push(`    \${CMAKE_CURRENT_SOURCE_DIR}${d === '.' ? '' : '/' + d}`);
    L.push(')');

    if (extra.length) {
      L.push('');
      L.push(`target_compile_options(${target} PRIVATE ${extra.join(' ')})`);
    }
    L.push('');
    return L.join('\n');
  }

  function generateReadme(opts) {
    const target = sanitizeTarget(opts.project);
    return `# ${target}

Exported from the C++ Playground. Build it with CMake:

    cmake -S . -B build
    cmake --build build --config Release

Then run the executable in \`build/\` (or \`build/Release/\` with multi-config
generators such as Visual Studio).

Compiler settings used in the playground:

- standard: ${opts.std}
- optimization: -O${opts.opt}
- extra flags: ${(opts.flags || '').trim() || '(none)'}
`;
  }

  global.generateCMakeLists = generateCMakeLists;
  global.generateReadme = generateReadme;
  global.sanitizeTarget = sanitizeTarget;
})(typeof self !== 'undefined' ? self : this);
