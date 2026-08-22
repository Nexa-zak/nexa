/**
 * Nexa QR — compact QR Code encoder (byte mode, versions 1–13, EC levels L/M/Q/H)
 * Data tables follow ISO/IEC 18004.
 *
 * The whole encoder lives inside the makeQR() factory so the exact same
 * source can be serialized with makeQR.toString() and shipped to the
 * browser inside the panel HTML — single source of truth, zero CDN.
 */

function makeQR() {
  'use strict';

  var EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };
  var EC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };

  // RS block layouts per version (1..13), each entry = 4 EC levels.
  // Triples of [blockCount, totalCodewords, dataCodewords].
  var RS = [
    [[1,26,19],[1,26,16],[1,26,13],[1,26,9]],
    [[1,44,34],[1,44,28],[1,44,22],[1,44,16]],
    [[1,70,55],[1,70,44],[2,35,17],[2,35,13]],
    [[1,100,80],[2,50,32],[2,50,24],[4,25,9]],
    [[1,134,108],[2,67,43],[2,33,15,2,34,16],[2,33,11,2,34,12]],
    [[2,86,68],[4,43,27],[4,43,19],[4,43,15]],
    [[2,98,78],[4,49,31],[2,32,14,4,33,15],[4,39,13,1,40,14]],
    [[2,121,97],[2,60,38,2,61,39],[4,40,18,2,41,19],[4,40,14,2,41,15]],
    [[2,146,116],[3,58,36,2,59,37],[4,36,16,4,37,17],[4,36,12,4,37,13]],
    [[2,86,68,2,87,69],[4,69,43,1,70,44],[6,43,19,2,44,20],[6,43,15,2,44,16]],
    [[4,101,81],[1,80,50,4,81,51],[4,50,22,4,51,23],[3,36,12,8,37,13]],
    [[2,116,92,2,117,93],[6,58,36,2,59,37],[4,46,20,6,47,21],[7,42,14,4,43,15]],
    [[4,133,107],[8,59,37,1,60,38],[8,44,20,4,45,21],[12,33,11,4,34,12]]
  ];

  var ALIGN = [
    [], [6,18], [6,22], [6,26], [6,30], [6,34], [6,22,38], [6,24,42],
    [6,26,46], [6,28,50], [6,30,54], [6,32,58], [6,34,62], [6,26,46,66]
  ];

  // ---- GF(256) ----
  var EXP = new Array(512);
  var LOG = new Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gmul(a, b) { if (a === 0 || b === 0) return 0; return EXP[LOG[a] + LOG[b]]; }

  var genCache = {};
  function rsGen(ecLen) {
    if (genCache[ecLen]) return genCache[ecLen];
    var poly = [1]; // poly[k] = coefficient of x^k  =>  constant term first
    for (var i = 0; i < ecLen; i++) {
      var next = new Array(poly.length + 1);
      for (var k = 0; k < next.length; k++) next[k] = 0;
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= gmul(poly[j], EXP[i]);
        next[j + 1] ^= poly[j];
      }
      poly = next;
    }
    genCache[ecLen] = poly;
    return poly;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGen(ecLen).slice().reverse(); // highest-degree first, gen[0] === 1
    var rem = new Array(ecLen);
    for (var r = 0; r < ecLen; r++) rem[r] = 0;
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ rem.shift();
      rem.push(0);
      if (factor !== 0) {
        for (var j = 0; j < ecLen; j++) rem[j] ^= gmul(gen[j + 1], factor);
      }
    }
    return rem;
  }

  function blocksFor(version, ec) {
    var def = RS[version - 1][EC_INDEX[ec]];
    var blocks = [];
    for (var t = 0; t < def.length; t += 3) {
      blocks.push({ count: def[t], total: def[t + 1], data: def[t + 2] });
    }
    return blocks;
  }

  function dataCapacity(version, ec) {
    var blocks = blocksFor(version, ec);
    var n = 0;
    for (var i = 0; i < blocks.length; i++) n += blocks[i].count * blocks[i].data;
    return n;
  }

  function makeCodewords(u8, version, ec) {
    var blocks = blocksFor(version, ec);
    var dataCount = dataCapacity(version, ec);

    var bits = [];
    function put(num, len) {
      for (var i = len - 1; i >= 0; i--) bits.push((num >>> i) & 1);
    }
    put(4, 4); // byte mode
    put(u8.length, version < 10 ? 8 : 16);
    for (var b = 0; b < u8.length; b++) put(u8[b], 8);

    var cap = dataCount * 8;
    if (bits.length + 4 > cap) throw new Error('QR: overflow v' + version);
    put(0, Math.min(4, cap - bits.length)); // terminator
    while (bits.length % 8 !== 0) bits.push(0);

    var codewords = [];
    for (var i = 0; i < bits.length; i += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      codewords.push(v);
    }
    var padByte = 0xec;
    while (codewords.length < dataCount) { codewords.push(padByte); padByte = padByte === 0xec ? 0x11 : 0xec; }

    // split into blocks, compute EC per block
    var dataBlocks = [], ecBlocks = [];
    var off = 0, maxData = 0, maxEc = 0;
    for (var bi = 0; bi < blocks.length; bi++) {
      var blk = blocks[bi];
      for (var c = 0; c < blk.count; c++) {
        var d = codewords.slice(off, off + blk.data);
        off += blk.data;
        var ecLen = blk.total - blk.data;
        dataBlocks.push(d);
        ecBlocks.push(rsEncode(d, ecLen));
        if (blk.data > maxData) maxData = blk.data;
        if (ecLen > maxEc) maxEc = ecLen;
      }
    }

    // interleave
    var out = [];
    for (var i2 = 0; i2 < maxData; i2++)
      for (var b2 = 0; b2 < dataBlocks.length; b2++)
        if (i2 < dataBlocks[b2].length) out.push(dataBlocks[b2][i2]);
    for (var i3 = 0; i3 < maxEc; i3++)
      for (var b3 = 0; b3 < ecBlocks.length; b3++)
        if (i3 < ecBlocks[b3].length) out.push(ecBlocks[b3][i3]);
    return out;
  }

  // ---- BCH for format / version info ----
  var G15 = 0x537, G15_MASK = 0x5412, G18 = 0x1f25;
  function bchDigit(d) { var n = 0; while (d !== 0) { n++; d >>>= 1; } return n; }
  function bchInfo(data) {
    var d = data << 10;
    while (bchDigit(d) - bchDigit(G15) >= 0) d ^= (G15 << (bchDigit(d) - bchDigit(G15)));
    return ((data << 10) | d) ^ G15_MASK;
  }
  function bchVersion(v) {
    var d = v << 12;
    while (bchDigit(d) - bchDigit(G18) >= 0) d ^= (G18 << (bchDigit(d) - bchDigit(G18)));
    return (v << 12) | d;
  }

  var MASKS = [
    function (i, j) { return (i + j) % 2 === 0; },
    function (i) { return i % 2 === 0; },
    function (i, j) { return j % 3 === 0; },
    function (i, j) { return (i + j) % 3 === 0; },
    function (i, j) { return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0; },
    function (i, j) { return (i * j) % 2 + (i * j) % 3 === 0; },
    function (i, j) { return ((i * j) % 2 + (i * j) % 3) % 2 === 0; },
    function (i, j) { return ((i * j) % 3 + (i + j) % 2) % 2 === 0; }
  ];

  function freshMatrix(size) {
    var m = [];
    for (var r = 0; r < size; r++) {
      var row = new Array(size);
      for (var c = 0; c < size; c++) row[c] = null;
      m.push(row);
    }
    return m;
  }

  function setupFunctionPatterns(m, size, version) {
    function set(r, c, v) { m[r][c] = v; }
    // finder patterns with separators
    function finder(row, col) {
      for (var r = -1; r <= 7; r++) {
        if (row + r < 0 || row + r >= size) continue;
        for (var c = -1; c <= 7; c++) {
          if (col + c < 0 || col + c >= size) continue;
          var dark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                     (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                     (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          set(row + r, col + c, !!dark);
        }
      }
    }
    finder(0, 0); finder(size - 7, 0); finder(0, size - 7);

    // alignment (drawn before timing; centers overlapping finders are already reserved)
    var pos = ALIGN[version - 1];
    for (var a = 0; a < pos.length; a++) {
      for (var b = 0; b < pos.length; b++) {
        var rr = pos[a], cc = pos[b];
        if (m[rr][cc] !== null) continue;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            set(rr + dr, cc + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
          }
        }
      }
    }

    // timing (skips cells already written, e.g. alignment on row/col 6 — values coincide)
    for (var i = 8; i < size - 8; i++) {
      if (m[6][i] === null) set(6, i, i % 2 === 0);
      if (m[i][6] === null) set(i, 6, i % 2 === 0);
    }

    // reserve format info areas (placeholder false), filled later per mask
    for (var f = 0; f < 15; f++) {
      var r1, c1;
      if (f < 6) r1 = f; else if (f < 8) r1 = f + 1; else r1 = size - 15 + f;
      m[r1][8] = false;
      if (f < 8) c1 = size - f - 1; else if (f < 9) c1 = 15 - f; else c1 = 15 - f - 1;
      m[8][c1] = false;
    }
    m[8][8] = false; // center of top-left finder's format block
    m[size - 8][8] = true; // dark module

    // version info (v >= 7)
    if (version >= 7) {
      var vb = bchVersion(version);
      for (var vi = 0; vi < 18; vi++) {
        var mod = ((vb >> vi) & 1) === 1;
        m[Math.floor(vi / 3)][vi % 3 + size - 11] = mod;
        m[vi % 3 + size - 11][Math.floor(vi / 3)] = mod;
      }
    }
  }

  function setupTypeInfo(m, size, ecName, maskIdx) {
    var data = (EC_BITS[ecName] << 3) | maskIdx;
    var bits = bchInfo(data);
    for (var i = 0; i < 15; i++) {
      var mod = ((bits >> i) & 1) === 1;
      var r1, c1;
      if (i < 6) r1 = i; else if (i < 8) r1 = i + 1; else r1 = size - 15 + i;
      m[r1][8] = mod;
      if (i < 8) c1 = size - i - 1; else if (i < 9) c1 = 15 - i; else c1 = 15 - i - 1;
      m[8][c1] = mod;
    }
  }

  function mapData(m, size, codewords, maskIdx) {
    var maskFn = MASKS[maskIdx];
    var inc = -1, row = size - 1, bitIndex = 7, byteIndex = 0;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      while (true) {
        for (var c = 0; c < 2; c++) {
          var cc = col - c;
          if (m[row][cc] === null) {
            var dark = false;
            if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
            if (maskFn(row, cc)) dark = !dark;
            m[row][cc] = dark;
            bitIndex--;
            if (bitIndex === -1) { byteIndex++; bitIndex = 7; }
          }
        }
        row += inc;
        if (row < 0 || row >= size) { row -= inc; inc = -inc; break; }
      }
    }
  }

  function penalty(m, size) {
    var lost = 0, r, c;
    // N1-ish: neighbors
    for (r = 0; r < size; r++) {
      for (c = 0; c < size; c++) {
        var same = 0;
        var dark = m[r][c];
        for (var dr = -1; dr <= 1; dr++) {
          if (r + dr < 0 || r + dr >= size) continue;
          for (var dc = -1; dc <= 1; dc++) {
            if (c + dc < 0 || c + dc >= size) continue;
            if (dr === 0 && dc === 0) continue;
            if (dark === m[r + dr][c + dc]) same++;
          }
        }
        if (same > 5) lost += (3 + same - 5);
      }
    }
    // N2: 2x2 blocks
    for (r = 0; r < size - 1; r++) {
      for (c = 0; c < size - 1; c++) {
        var cnt = 0;
        if (m[r][c]) cnt++;
        if (m[r][c + 1]) cnt++;
        if (m[r + 1][c]) cnt++;
        if (m[r + 1][c + 1]) cnt++;
        if (cnt === 0 || cnt === 4) lost += 3;
      }
    }
    // N3: 1011101 with 0000
    for (r = 0; r < size; r++) {
      for (c = 0; c < size - 10; c++) {
        if (m[r][c] && !m[r][c + 1] && m[r][c + 2] && m[r][c + 3] && m[r][c + 4] && !m[r][c + 5] && m[r][c + 6] &&
            !m[r][c + 7] && !m[r][c + 8] && !m[r][c + 9] && !m[r][c + 10]) lost += 40;
        if (!m[r][c] && !m[r][c + 1] && !m[r][c + 2] && !m[r][c + 3] && m[r][c + 4] && !m[r][c + 5] && m[r][c + 6] &&
            m[r][c + 7] && m[r][c + 8] && !m[r][c + 9] && m[r][c + 10]) lost += 40;
      }
    }
    for (c = 0; c < size; c++) {
      for (r = 0; r < size - 10; r++) {
        if (m[r][c] && !m[r + 1][c] && m[r + 2][c] && m[r + 3][c] && m[r + 4][c] && !m[r + 5][c] && m[r + 6][c] &&
            !m[r + 7][c] && !m[r + 8][c] && !m[r + 9][c] && !m[r + 10][c]) lost += 40;
        if (!m[r][c] && !m[r + 1][c] && !m[r + 2][c] && !m[r + 3][c] && m[r + 4][c] && !m[r + 5][c] && m[r + 6][c] &&
            m[r + 7][c] && !m[r + 8][c] && m[r + 10][c]) lost += 40;
      }
    }
    // N4: dark ratio
    var darkCount = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (m[r][c]) darkCount++;
    lost += Math.floor(Math.abs(100 * darkCount / (size * size) - 50) / 5) * 10;
    return lost;
  }

  function textToU8(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text);
    // fallback (rare)
    var out = [];
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 128) out.push(c);
      else if (c < 2048) { out.push(0xc0 | (c >> 6), 0x80 | (c & 63)); }
      else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }

  /**
   * qrEncode(text, ecLevel) -> { size, m }
   *  m[row][col] === true for dark modules.
   */
  function qrEncode(text, ecName, forceMask) {
    ecName = EC_INDEX.hasOwnProperty(ecName) ? ecName : 'M';
    var u8 = textToU8(text);
    var version = 0;
    for (var v = 1; v <= 13; v++) {
      var need = u8.length + Math.ceil((4 + (v < 10 ? 8 : 16) + 4) / 8);
      if (need <= dataCapacity(v, ecName)) { version = v; break; }
    }
    if (!version) throw new Error('QR: text too long (max ~330 bytes at M)');

    var codewords = makeCodewords(u8, version, ecName);
    var size = version * 4 + 17;
    var best = null, bestScore = Infinity, bestMask = 0;
    for (var mask = 0; mask < 8; mask++) {
      var m = freshMatrix(size);
      setupFunctionPatterns(m, size, version);
      mapData(m, size, codewords, mask);
      setupTypeInfo(m, size, ecName, mask);
      var score = forceMask !== undefined ? (forceMask === mask ? 0 : 1e9) : penalty(m, size);
      if (score < bestScore) { bestScore = score; best = m; bestMask = mask; }
    }
    return { size: size, m: best, mask: bestMask, version: version };
  }

  return { qrEncode: qrEncode };
}

export { makeQR };
