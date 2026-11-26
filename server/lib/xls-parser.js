// Zero-dependency .xls (OLE2 Compound File Binary + BIFF8) reader for Node.js.
// Supports LinkedIn Company Page .xls exports (followers, visitors, content)
// returning the same shape as parseXlsxBuffer:
//   { sheetNames: string[], sheets: Record<string, (string | null)[][]> }

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

function readOleWorkbookStream(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 512) {
    throw new Error('Invalid .xls file (buffer too small).');
  }
  // OLE2 magic: D0 CF 11 E0 A1 B1 1A E1
  if (buf.readUInt32BE(0) !== 0xd0cf11e0 || buf.readUInt32BE(4) !== 0xa1b11ae1) {
    throw new Error('Not a valid OLE2 .xls file.');
  }

  const sectorShift = buf.readUInt16LE(30);
  const sectorSize = 1 << sectorShift; // usually 512
  const miniSectorShift = buf.readUInt16LE(32);
  const miniSectorSize = 1 << miniSectorShift; // usually 64
  const firstDirSector = buf.readUInt32LE(48);
  const miniCutoff = buf.readUInt32LE(56); // usually 4096
  const firstMiniFatSector = buf.readUInt32LE(60);
  const firstDifatSector = buf.readUInt32LE(68);
  const numDifatSectors = buf.readUInt32LE(72);

  const sectorOffset = (sec) => (sec + 1) * sectorSize;

  // 1. Collect FAT sector indices from header DIFAT (109 entries) + DIFAT chain
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(76 + i * 4);
    if (s !== FREESECT && s !== ENDOFCHAIN) fatSectors.push(s);
  }
  let difatSec = firstDifatSector;
  for (let d = 0; d < numDifatSectors && difatSec !== ENDOFCHAIN && difatSec !== FREESECT; d++) {
    const off = sectorOffset(difatSec);
    const entries = (sectorSize / 4) - 1;
    for (let i = 0; i < entries; i++) {
      const s = buf.readUInt32LE(off + i * 4);
      if (s !== FREESECT && s !== ENDOFCHAIN) fatSectors.push(s);
    }
    difatSec = buf.readUInt32LE(off + entries * 4);
  }

  // 2. Build FAT array
  const fat = [];
  for (const fs of fatSectors) {
    const off = sectorOffset(fs);
    if (off + sectorSize > buf.length) continue;
    for (let i = 0; i < sectorSize; i += 4) {
      fat.push(buf.readUInt32LE(off + i));
    }
  }

  function readChain(startSec, maxBytes) {
    const chunks = [];
    let sec = startSec;
    let guard = 0;
    while (sec !== ENDOFCHAIN && sec !== FREESECT && sec < fat.length && guard++ < 200000) {
      const off = sectorOffset(sec);
      if (off + sectorSize <= buf.length) {
        chunks.push(buf.subarray(off, off + sectorSize));
      }
      sec = fat[sec];
    }
    const full = Buffer.concat(chunks);
    return maxBytes != null ? full.subarray(0, maxBytes) : full;
  }

  // 3. Read directory entries
  const dirBuf = readChain(firstDirSector);
  let rootEntry = null;
  let wbEntry = null;

  for (let off = 0; off + 128 <= dirBuf.length; off += 128) {
    const nameLen = dirBuf.readUInt16LE(off + 64);
    if (nameLen < 2 || nameLen > 64) continue;
    const type = dirBuf[off + 66]; // 5=root, 2=stream
    const name = dirBuf.subarray(off, off + nameLen - 2).toString('utf16le');
    const startSec = dirBuf.readUInt32LE(off + 116);
    const size = dirBuf.readUInt32LE(off + 120);
    if (type === 5) rootEntry = { startSec, size };
    if (type === 2 && (name === 'Workbook' || name === 'Book' || name.toLowerCase() === 'workbook')) {
      wbEntry = { name, startSec, size };
    }
  }

  if (!wbEntry) {
    throw new Error('Missing Workbook stream in .xls file.');
  }

  if (wbEntry.size >= miniCutoff || !rootEntry) {
    return readChain(wbEntry.startSec, wbEntry.size);
  }

  // Mini-stream fallback for tiny < 4KB workbooks
  const miniStream = readChain(rootEntry.startSec, rootEntry.size);
  const miniFatBuf = readChain(firstMiniFatSector);
  const miniFat = [];
  for (let i = 0; i + 4 <= miniFatBuf.length; i += 4) {
    miniFat.push(miniFatBuf.readUInt32LE(i));
  }
  const chunks = [];
  let msec = wbEntry.startSec;
  let guard = 0;
  while (msec !== ENDOFCHAIN && msec !== FREESECT && msec < miniFat.length && guard++ < 50000) {
    const moff = msec * miniSectorSize;
    chunks.push(miniStream.subarray(moff, moff + miniSectorSize));
    msec = miniFat[msec];
  }
  return Buffer.concat(chunks).subarray(0, wbEntry.size);
}

function decodeRk(rk) {
  const isDiv100 = (rk & 0x01) !== 0;
  const isInt = (rk & 0x02) !== 0;
  let val;
  if (isInt) {
    val = rk >> 2; // signed 30-bit int
  } else {
    const tmp = Buffer.alloc(8);
    tmp.writeUInt32LE(0, 0);
    tmp.writeUInt32LE(rk & 0xfffffffc, 4);
    val = tmp.readDoubleLE(0);
  }
  return isDiv100 ? val / 100 : val;
}

// Parse BIFF8 SST (opcode 0x00FC) + following CONTINUE (0x003C) records
function parseSstRecords(sstChunks) {
  if (!sstChunks.length) return [];
  let chunkIdx = 0;
  let offset = 8; // skip cstTotal (4) + cstUnique (4) in first SST record
  const totalUnique = sstChunks[0].readUInt32LE(4);
  const strings = [];

  function ensureBytes(n) {
    while (chunkIdx < sstChunks.length && offset >= sstChunks[chunkIdx].length) {
      chunkIdx++;
      offset = 0;
    }
    return chunkIdx < sstChunks.length && offset + n <= sstChunks[chunkIdx].length;
  }

  function readUInt8() {
    ensureBytes(1);
    return sstChunks[chunkIdx][offset++];
  }

  function readUInt16LE() {
    if (!ensureBytes(2)) {
      const b0 = readUInt8();
      const b1 = readUInt8();
      return b0 | (b1 << 8);
    }
    const v = sstChunks[chunkIdx].readUInt16LE(offset);
    offset += 2;
    return v;
  }

  function readUInt32LE() {
    if (!ensureBytes(4)) {
      const w0 = readUInt16LE();
      const w1 = readUInt16LE();
      return (w0 | (w1 << 16)) >>> 0;
    }
    const v = sstChunks[chunkIdx].readUInt32LE(offset);
    offset += 4;
    return v;
  }

  function skipBytes(n) {
    let rem = n;
    while (rem > 0 && chunkIdx < sstChunks.length) {
      const avail = sstChunks[chunkIdx].length - offset;
      if (avail <= 0) {
        chunkIdx++;
        offset = 0;
        continue;
      }
      const take = Math.min(rem, avail);
      offset += take;
      rem -= take;
    }
  }

  for (let s = 0; s < totalUnique && chunkIdx < sstChunks.length; s++) {
    if (!ensureBytes(3)) break;
    const cch = readUInt16LE();
    const flags = readUInt8();
    let isUtf16 = (flags & 0x01) !== 0;
    const hasExt = (flags & 0x04) !== 0;
    const hasRich = (flags & 0x08) !== 0;

    const rtRuns = hasRich ? readUInt16LE() : 0;
    const extSize = hasExt ? readUInt32LE() : 0;

    let charsLeft = cch;
    let out = '';
    while (charsLeft > 0 && chunkIdx < sstChunks.length) {
      if (offset >= sstChunks[chunkIdx].length) {
        chunkIdx++;
        offset = 0;
        if (chunkIdx >= sstChunks.length) break;
        // CONTINUE record starts with 1-byte encoding flag for split strings
        const contFlag = sstChunks[chunkIdx][offset++];
        isUtf16 = (contFlag & 0x01) !== 0;
      }
      const bpc = isUtf16 ? 2 : 1;
      const availChars = Math.floor((sstChunks[chunkIdx].length - offset) / bpc);
      const takeChars = Math.min(charsLeft, availChars);
      const byteLen = takeChars * bpc;
      const slice = sstChunks[chunkIdx].subarray(offset, offset + byteLen);
      out += isUtf16 ? slice.toString('utf16le') : slice.toString('latin1');
      offset += byteLen;
      charsLeft -= takeChars;
    }

    if (rtRuns > 0) skipBytes(rtRuns * 4);
    if (extSize > 0) skipBytes(extSize);

    strings.push(out);
  }

  return strings;
}

function readBiff8String(buf, off, lenBytes = 2) {
  const cch = lenBytes === 1 ? buf[off] : buf.readUInt16LE(off);
  const flags = buf[off + lenBytes];
  const isUtf16 = (flags & 0x01) !== 0;
  const start = off + lenBytes + 1;
  if (isUtf16) {
    return buf.subarray(start, start + cch * 2).toString('utf16le');
  }
  return buf.subarray(start, start + cch).toString('latin1');
}

function formatNumVal(v) {
  if (!Number.isFinite(v)) return null;
  // Preserve exact integer or clean decimal string
  if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  return String(v);
}

function parseWorksheetStream(wb, startOffset, sst) {
  const rows = [];
  function setCell(r, c, val) {
    while (rows.length <= r) rows.push([]);
    while (rows[r].length <= c) rows[r].push(null);
    rows[r][c] = val;
  }

  let pos = startOffset;
  let lastFormulaPos = null;

  while (pos + 4 <= wb.length) {
    const opcode = wb.readUInt16LE(pos);
    const len = wb.readUInt16LE(pos + 2);
    const dataStart = pos + 4;
    const dataEnd = dataStart + len;
    if (dataEnd > wb.length) break;
    pos = dataEnd;

    if (opcode === 0x000a) break; // EOF

    if (opcode === 0x00fd && len >= 10) {
      // LABELSST
      const r = wb.readUInt16LE(dataStart);
      const c = wb.readUInt16LE(dataStart + 2);
      const sstIdx = wb.readUInt32LE(dataStart + 6);
      setCell(r, c, sstIdx < sst.length ? sst[sstIdx] : '');
      lastFormulaPos = null;
    } else if (opcode === 0x0204 && len >= 8) {
      // LABEL
      const r = wb.readUInt16LE(dataStart);
      const c = wb.readUInt16LE(dataStart + 2);
      setCell(r, c, readBiff8String(wb, dataStart + 6, 2));
      lastFormulaPos = null;
    } else if (opcode === 0x0203 && len >= 14) {
      // NUMBER
      const r = wb.readUInt16LE(dataStart);
      const c = wb.readUInt16LE(dataStart + 2);
      const num = wb.readDoubleLE(dataStart + 6);
      setCell(r, c, formatNumVal(num));
      lastFormulaPos = null;
    } else if (opcode === 0x027e && len >= 10) {
      // RK
      const r = wb.readUInt16LE(dataStart);
      const c = wb.readUInt16LE(dataStart + 2);
      const rk = wb.readUInt32LE(dataStart + 6);
      setCell(r, c, formatNumVal(decodeRk(rk)));
      lastFormulaPos = null;
    } else if (opcode === 0x00bd && len >= 6) {
      // MULRK
      const r = wb.readUInt16LE(dataStart);
      const cFirst = wb.readUInt16LE(dataStart + 2);
      const cLast = wb.readUInt16LE(dataEnd - 2);
      let off = dataStart + 4;
      for (let c = cFirst; c <= cLast && off + 6 <= dataEnd - 2; c++, off += 6) {
        const rk = wb.readUInt32LE(off + 2);
        setCell(r, c, formatNumVal(decodeRk(rk)));
      }
      lastFormulaPos = null;
    } else if (opcode === 0x0006 && len >= 20) {
      // FORMULA
      const r = wb.readUInt16LE(dataStart);
      const c = wb.readUInt16LE(dataStart + 2);
      const flagByte6 = wb[dataStart + 12];
      const flagByte7 = wb[dataStart + 13];
      if (flagByte6 === 0xff && flagByte7 === 0xff) {
        const type = wb[dataStart + 6];
        if (type === 0) {
          // String result follows in next STRING (0x0207) record
          lastFormulaPos = { r, c };
        } else if (type === 1) {
          setCell(r, c, wb[dataStart + 8] ? 'TRUE' : 'FALSE');
          lastFormulaPos = null;
        } else {
          lastFormulaPos = null;
        }
      } else {
        const num = wb.readDoubleLE(dataStart + 6);
        setCell(r, c, formatNumVal(num));
        lastFormulaPos = null;
      }
    } else if (opcode === 0x0207 && lastFormulaPos && len >= 3) {
      // STRING (cached formula string)
      setCell(lastFormulaPos.r, lastFormulaPos.c, readBiff8String(wb, dataStart, 2));
      lastFormulaPos = null;
    } else if (opcode === 0x0205 && len >= 8) {
      // BOOLERR
      const r = wb.readUInt16LE(dataStart);
      const c = wb.readUInt16LE(dataStart + 2);
      const isErr = wb[dataStart + 7];
      if (!isErr) setCell(r, c, wb[dataStart + 6] ? 'TRUE' : 'FALSE');
      lastFormulaPos = null;
    }
  }

  return rows;
}

/**
 * Parse a BIFF8 .xls Buffer into sheets.
 * @param {Buffer} buffer
 * @returns {{ sheetNames: string[], sheets: Record<string, (string | null)[][]> }}
 */
export function parseXlsBuffer(buffer) {
  const wb = readOleWorkbookStream(buffer);
  const boundSheets = [];
  const sstChunks = [];
  let inSst = false;

  let pos = 0;
  while (pos + 4 <= wb.length) {
    const opcode = wb.readUInt16LE(pos);
    const len = wb.readUInt16LE(pos + 2);
    const dataStart = pos + 4;
    const dataEnd = dataStart + len;
    if (dataEnd > wb.length) break;
    pos = dataEnd;

    if (opcode === 0x000a) break; // Workbook globals EOF

    if (opcode === 0x0085 && len >= 8) {
      // BOUNDSHEET
      const bofOffset = wb.readUInt32LE(dataStart);
      const name = readBiff8String(wb, dataStart + 6, 1);
      boundSheets.push({ name, bofOffset });
      inSst = false;
    } else if (opcode === 0x00fc) {
      // SST
      sstChunks.push(wb.subarray(dataStart, dataEnd));
      inSst = true;
    } else if (opcode === 0x003c && inSst) {
      // CONTINUE for SST
      sstChunks.push(wb.subarray(dataStart, dataEnd));
    } else {
      inSst = false;
    }
  }

  const sst = parseSstRecords(sstChunks);
  const sheetNames = [];
  const sheets = {};

  for (const bs of boundSheets) {
    sheetNames.push(bs.name);
    sheets[bs.name] = parseWorksheetStream(wb, bs.bofOffset, sst);
  }

  if (!sheetNames.length) {
    throw new Error('No readable worksheets found in .xls file.');
  }

  return { sheetNames, sheets };
}
