'use strict';
// Minimal .xlsx reader — just enough to read a single sheet's cell values.
// An .xlsx is a zip of XML; no external dependency needed for a small file.
const zlib = require('zlib');

function unzipEntries(buf) {
  const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50;
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === EOCD_SIG) { eocdPos = i; break; }
  if (eocdPos === -1) throw new Error('not a zip file (EOCD not found)');
  const total = buf.readUInt16LE(eocdPos + 10), cdOffset = buf.readUInt32LE(eocdPos + 16);
  const entries = {};
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error(`bad central directory record at ${p}`);
    const method = buf.readUInt16LE(p + 10), compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26), localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    entries[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) {
    const text = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('');
    out.push(decodeEntities(text));
  }
  return out;
}

// Returns rows as arrays indexed by 0-based column number (A=0, B=1, ...), sparse.
function parseSheetRows(xml, sharedStrings) {
  const colNum = ref => {
    const m = /^([A-Z]+)/.exec(ref);
    let n = 0;
    for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const row = [];
    const cellRe = /<c r="([A-Z]+\d+)"(?:[^>]*\bt="([a-zA-Z]+)")?[^>]*>(?:<v>([\s\S]*?)<\/v>|<is>([\s\S]*?)<\/is>)?<\/c>/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const [, ref, type, v, isBlock] = cm;
      let value = null;
      if (type === 's' && v != null) value = sharedStrings[Number(v)];
      else if (isBlock != null) value = decodeEntities((isBlock.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [, ''])[1]);
      else if (v != null) value = Number(v);
      row[colNum(ref)] = value;
    }
    rows.push(row);
  }
  return rows;
}

function readXlsxSheet(buf, sheetName = 'xl/worksheets/sheet1.xml') {
  const entries = unzipEntries(buf);
  const sharedStrings = parseSharedStrings(entries['xl/sharedStrings.xml'] && entries['xl/sharedStrings.xml'].toString('utf8'));
  const rows = parseSheetRows(entries[sheetName].toString('utf8'), sharedStrings);
  return { rows, sharedStrings };
}

module.exports = { readXlsxSheet };
