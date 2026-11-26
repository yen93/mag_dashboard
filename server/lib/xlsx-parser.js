// Zero-dependency .xlsx (Office Open XML) reader using Node's built-in node:zlib.
// Parses ZIP central directory + workbook.xml + sharedStrings.xml + worksheet XMLs
// into { sheetNames: string[], sheets: Record<string, (string | null)[][]> }.

import zlib from 'node:zlib';

function decodeXmlEntities(s) {
  if (!s) return '';
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, ent) => {
    if (ent === 'amp') return '&';
    if (ent === 'lt') return '<';
    if (ent === 'gt') return '>';
    if (ent === 'quot') return '"';
    if (ent === 'apos') return "'";
    if (ent.startsWith('#x')) return String.fromCodePoint(parseInt(ent.slice(2), 16));
    if (ent.startsWith('#')) return String.fromCodePoint(parseInt(ent.slice(1), 10));
    return _m;
  });
}

function unzipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw new Error('Invalid .xlsx file (buffer too small).');
  }
  // Locate End of Central Directory (EOCD) signature 0x06054b50 near the end of the file.
  const minPos = Math.max(0, buf.length - 65557);
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) {
    throw new Error('Invalid .xlsx file (not a valid ZIP archive).');
  }

  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  const cdOffset = buf.readUInt32LE(eocdPos + 16);

  const files = new Map();
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) {
      throw new Error('Corrupt .xlsx ZIP central directory.');
    }
    const compression = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);

    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;

    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      continue;
    }
    const lhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);

    let raw;
    if (compression === 0) {
      raw = compData;
    } else if (compression === 8) {
      raw = zlib.inflateRawSync(compData);
    } else {
      throw new Error(`Unsupported ZIP compression method ${compression} in .xlsx.`);
    }
    files.set(name.replace(/^\/+/, ''), raw);
  }
  return files;
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag)) !== null) {
    attrs[m[1]] = decodeXmlEntities(m[2]);
  }
  return attrs;
}

function colLettersToIndex(letters) {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const body = m[1];
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = tRe.exec(body)) !== null) {
      text += decodeXmlEntities(tm[1]);
    }
    strings.push(text);
  }
  return strings;
}

function parseWorksheet(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const rowAttrs = parseAttrs(rm[1]);
    const rowNum = rowAttrs.r ? parseInt(rowAttrs.r, 10) : rows.length + 1;
    while (rows.length < rowNum - 1) rows.push([]);

    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    let fallbackCol = 0;
    while ((cm = cellRe.exec(rm[2])) !== null) {
      const cAttrs = parseAttrs(cm[1]);
      const cBody = cm[2] || '';
      const ref = cAttrs.r || '';
      const colMatch = ref.match(/^([A-Z]+)/i);
      const colIdx = colMatch ? colLettersToIndex(colMatch[1].toUpperCase()) : fallbackCol;
      fallbackCol = colIdx + 1;

      const t = cAttrs.t || '';
      let val = null;

      if (t === 'inlineStr') {
        let s = '';
        const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let tm;
        while ((tm = tRe.exec(cBody)) !== null) s += decodeXmlEntities(tm[1]);
        val = s;
      } else {
        const vMatch = cBody.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        if (vMatch) {
          const rawV = decodeXmlEntities(vMatch[1]);
          if (t === 's') {
            const si = parseInt(rawV, 10);
            val = Number.isInteger(si) && si >= 0 && si < sharedStrings.length ? sharedStrings[si] : rawV;
          } else {
            val = rawV;
          }
        }
      }

      while (cells.length < colIdx) cells.push(null);
      cells[colIdx] = val;
    }

    rows[rowNum - 1] = cells;
  }
  return rows;
}

/**
 * Parse an .xlsx Buffer into sheets.
 * @param {Buffer} buffer
 * @returns {{ sheetNames: string[], sheets: Record<string, (string | null)[][]> }}
 */
export function parseXlsxBuffer(buffer) {
  const files = unzipEntries(buffer);
  const workbookBuf = files.get('xl/workbook.xml');
  if (!workbookBuf) {
    throw new Error('Missing xl/workbook.xml — file does not appear to be a valid .xlsx workbook.');
  }
  const workbookXml = workbookBuf.toString('utf8');

  const relsBuf = files.get('xl/_rels/workbook.xml.rels');
  const relsXml = relsBuf ? relsBuf.toString('utf8') : '';
  const relMap = new Map();
  const relRe = /<Relationship\b([^>]*)\/?>/g;
  let relM;
  while ((relM = relRe.exec(relsXml)) !== null) {
    const a = parseAttrs(relM[1]);
    if (a.Id && a.Target) {
      let target = a.Target.replace(/^\/+/, '');
      if (!target.startsWith('xl/')) target = 'xl/' + target.replace(/^\.\//, '');
      relMap.set(a.Id, target);
    }
  }

  const ssBuf = files.get('xl/sharedStrings.xml');
  const sharedStrings = ssBuf ? parseSharedStrings(ssBuf.toString('utf8')) : [];

  const sheetNames = [];
  const sheets = {};
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let sm;
  let sheetIdx = 0;
  while ((sm = sheetRe.exec(workbookXml)) !== null) {
    sheetIdx++;
    const a = parseAttrs(sm[1]);
    const name = a.name || `Sheet${sheetIdx}`;
    const rId = a['r:id'] || a.id;
    const target = (rId && relMap.get(rId)) || `xl/worksheets/sheet${sheetIdx}.xml`;
    const wsBuf = files.get(target);
    if (!wsBuf) continue;
    sheetNames.push(name);
    sheets[name] = parseWorksheet(wsBuf.toString('utf8'), sharedStrings);
  }

  if (!sheetNames.length) {
    throw new Error('No readable worksheets found in .xlsx file.');
  }

  return { sheetNames, sheets };
}
