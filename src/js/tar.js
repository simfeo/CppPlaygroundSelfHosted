/* ustar reader; enough for the sysroot archive we produce ourselves. */
(function (global) {
  'use strict';

  function readStr(u8, offset, len) {
    let end = offset;
    const limit = offset + len;
    while (end < limit && u8[end] !== 0) end++;
    return new TextDecoder().decode(u8.subarray(offset, end));
  }

  function readOctal(u8, offset, len) {
    const str = readStr(u8, offset, len).trim();
    return str ? parseInt(str, 8) : 0;
  }

  // Calls onEntry(name, data) for every regular file in the archive.
  function untar(buffer, onEntry) {
    const u8 = new Uint8Array(buffer);
    let offset = 0;

    while (offset + 512 <= u8.length) {
      const name = readStr(u8, offset, 100);
      if (!name) break; // end-of-archive padding

      const size = readOctal(u8, offset + 124, 12);
      const type = String.fromCharCode(u8[offset + 156]) || '0';
      const prefix = readStr(u8, offset + 345, 155);
      offset += 512;

      if (type === '0' || type === '\0') {
        const full = prefix ? `${prefix}/${name}` : name;
        onEntry(full, u8.subarray(offset, offset + size));
      }
      offset += Math.ceil(size / 512) * 512;
    }
  }

  async function gunzip(buffer) {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }

  global.untar = untar;
  global.gunzip = gunzip;
})(typeof self !== 'undefined' ? self : this);
