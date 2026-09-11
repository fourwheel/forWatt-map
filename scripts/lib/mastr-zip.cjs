'use strict';
// Minimal remote-ZIP reader for the MaStR Gesamtdatenexport.
//
// The export is a single ZIP file several GB in size, served with HTTP
// Range support. We never download the whole thing: we read the central
// directory (a few hundred KB at the end of the file) to find where each
// XML table lives, then range-fetch just the entries we need.
const https = require('https');
const zlib = require('zlib');

function get(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        res.resume();
        reject(new Error(`${url} -> HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}
async function head(url) {
  return new Promise((resolve, reject) => {
    https.request(url, { method: 'HEAD' }, res => {
      res.resume();
      resolve(parseInt(res.headers['content-length'], 10));
    }).on('error', reject).end();
  });
}
const range = (a, b) => ({ Range: `bytes=${a}-${b}` });

const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50;

async function openRemoteZip(url) {
  const size = await head(url);
  const tailLen = Math.min(size, 1 << 20); // 1MB is plenty for the EOCD + comment
  const tail = await get(url, range(size - tailLen, size - 1));
  let eocdPos = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) { eocdPos = i; break; }
  }
  if (eocdPos === -1) throw new Error('EOCD not found — zip too large for this reader (needs Zip64 support)');
  const total = tail.readUInt16LE(eocdPos + 10);
  const cdSize = tail.readUInt32LE(eocdPos + 12);
  const cdOffset = tail.readUInt32LE(eocdPos + 16);

  const cd = (cdOffset + cdSize >= size - tailLen)
    ? tail.subarray(cdOffset - (size - tailLen))
    : await get(url, range(cdOffset, cdOffset + cdSize - 1));

  const entries = new Map();
  let p = 0;
  for (let i = 0; i < total; i++) {
    if (cd.readUInt32LE(p) !== CEN_SIG) throw new Error(`bad central directory record at ${p}`);
    const method = cd.readUInt16LE(p + 10);
    const compressedSize = cd.readUInt32LE(p + 20);
    const uncompressedSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const localHeaderOffset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  async function readEntry(name) {
    const e = entries.get(name);
    if (!e) throw new Error(`entry not found: ${name}`);
    const localHead = await get(url, range(e.localHeaderOffset, e.localHeaderOffset + 29));
    const nameLen = localHead.readUInt16LE(26);
    const extraLen = localHead.readUInt16LE(28);
    const dataStart = e.localHeaderOffset + 30 + nameLen + extraLen;
    const raw = await get(url, range(dataStart, dataStart + e.compressedSize - 1));
    const decompressed = e.method === 0 ? raw : zlib.inflateRawSync(raw);
    return decodeMastrXml(decompressed);
  }

  return { size, entries, readEntry };
}

function decodeMastrXml(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le', 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return buf.swap16().toString('utf16le', 2);
  return buf.toString('utf8');
}

module.exports = { openRemoteZip };
