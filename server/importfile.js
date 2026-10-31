// Reads the people list for the bulk import (Scale): a .csv (UTF-8 with or without BOM, or Excel's Windows-1252 / UTF-16
// "CSV", separated by , ; or tab, with quotes) or an .xlsx (first sheet). No library: .xlsx is a zip of XML files, read here
// with the zlib that ships with Node. Nothing is written to disk. The file is size-limited, every inflated part is
// size-limited (zip bombs), and nothing in it is ever run.
//   parsePeople(buffer, fileName) -> { rows: [{ line, name, email, team, role }] }  or throws Error with a message for the admin
const zlib = require('zlib');

const MAX_BYTES = 2 * 1024 * 1024, MAX_ROWS = 2000, MAX_COLS = 40;
const MAX_PART = 8 * 1024 * 1024; // largest inflated part we accept (sheet or shared strings)

const fail = m => { throw Object.assign(new Error(m), { userMessage: true }); };

// ---------- CSV ----------
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch (e) { return new TextDecoder('windows-1252').decode(buf); } // Excel's "CSV (Comma delimited)" on Windows
}
function parseCsv(text) {
  // The separator is whichever of , ; tab is most common in the first line outside quotes.
  const first = text.split(/\r?\n/, 1)[0] || '';
  let best = ',', bestN = -1;
  for (const d of [',', ';', '\t']) { let n = 0, q = false; for (const c of first) { if (c === '"') q = !q; else if (c === d && !q) n++; } if (n > bestN) { best = d; bestN = n; } }
  // Blank lines stay in place (as empty rows) so a row number in a message is the row in the user's file.
  const rows = []; let row = [], cell = '', q = false, i = 0, data = 0;
  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => { endCell(); if (row.some(c => c.trim() !== '')) { data++; if (data > MAX_ROWS + 1) fail(`Too many rows (the most is ${MAX_ROWS} people per import).`); } rows.push(row); row = []; };
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"' && cell === '') q = true;
    else if (c === best) endCell();
    else if (c === '\n') endRow();
    else if (c === '\r') { if (text[i + 1] === '\n') i++; endRow(); }
    else cell += c;
    if (cell.length > 2000) fail('A cell in the file is far too long. Is this the right file?');
  }
  if (q) fail('The file has an opening quote (") that is never closed.');
  if (cell !== '' || row.length) endRow();
  while (rows.length && rows[rows.length - 1].every(c => c.trim() === '')) rows.pop();
  return rows.map(r => r.slice(0, MAX_COLS).map(c => c.trim()));
}

// ---------- XLSX ----------
function readZip(buf) {
  // End of central directory record: the last 22+ bytes.
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) fail('This isn’t a valid .xlsx file. Save it again from Excel as “Excel Workbook (.xlsx)” or as CSV.');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  if (count === 0xffff || p === 0xffffffff) fail('This workbook is too large or uses an unsupported zip format. Save it as CSV instead.');
  if (count > 2000) fail('The workbook has too many parts.');
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('The .xlsx file is damaged.');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    entries[buf.toString('utf8', p + 46, p + 46 + nlen)] = { flags, method, csize, usize, off };
    p += 46 + nlen + xlen + clen;
  }
  return name => {
    const en = entries[name]; if (!en) return null;
    if (en.flags & 1) fail('This workbook is password protected. Remove the password, or save it as CSV.');
    if (en.usize > MAX_PART) fail('A part of the workbook is far too large. Is this the right file?');
    if (en.off + 30 > buf.length || buf.readUInt32LE(en.off) !== 0x04034b50) fail('The .xlsx file is damaged.');
    const start = en.off + 30 + buf.readUInt16LE(en.off + 26) + buf.readUInt16LE(en.off + 28);
    const data = buf.subarray(start, start + en.csize);
    if (en.method === 0) return data.toString('utf8');
    if (en.method !== 8) fail('The .xlsx file uses an unsupported compression.');
    try { return zlib.inflateRawSync(data, { maxOutputLength: MAX_PART }).toString('utf8'); }
    catch (err) { fail(err.code === 'ERR_BUFFER_TOO_LARGE' ? 'A part of the workbook is far too large. Is this the right file?' : 'The .xlsx file is damaged.'); }
  };
}
const xmlText = s => s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (m, g) => {
  if (g[0] === '#') { const c = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ''; }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[g.toLowerCase()];
});
// All the text pieces <t> of an element (rich text has several; phonetic runs <rPh> are left out).
const textOf = xml => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => xmlText(m[1])).join('');
const colIndex = ref => { let n = 0; for (const c of ref.replace(/[^A-Za-z]/g, '').toUpperCase()) n = n * 26 + c.charCodeAt(0) - 64; return n - 1; };

function parseXlsx(buf) {
  const file = readZip(buf);
  if (!file('[Content_Types].xml') && !file('xl/workbook.xml')) fail('This isn’t an Excel workbook (.xlsx).');
  const shared = [];
  const sst = file('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(m[1] ? textOf(m[1]) : '');
  // The first sheet in the workbook's order.
  let sheetPath = null;
  const wb = file('xl/workbook.xml'), rels = file('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const rid = (wb.match(/<sheet\b[^>]*\br:id="([^"]+)"/) || [])[1];
    const rel = rid && [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(t => new RegExp(`\\bId="${rid}"`).test(t));
    const target = rel && (rel.match(/\bTarget="([^"]+)"/) || [])[1];
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  }
  let xml = sheetPath && file(sheetPath);
  if (!xml) xml = file('xl/worksheets/sheet1.xml');
  if (!xml) fail('The workbook has no sheet to read.');
  const rows = [];
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rn = Number((rm[1].match(/\br="(\d+)"/) || [])[1]) || rows.length + 1;
    const cells = [];
    for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], body = cm[2] || '';
      const ref = (attrs.match(/\br="([A-Za-z]+\d+)"/) || [])[1];
      const ci = ref ? colIndex(ref) : cells.length;
      if (ci >= MAX_COLS) continue;
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
      let v = '';
      if (type === 'inlineStr') v = textOf(body);
      else { const raw = (body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) || [])[1]; if (raw !== undefined) v = type === 's' ? (shared[Number(raw)] || '') : xmlText(raw); }
      if (type === 'e') v = ''; // an error value (#N/A)
      cells[ci] = String(v).trim();
    }
    const filled = Array.from(cells, c => c || '');
    if (!filled.some(c => c !== '')) continue; // empty (maybe formatted) row: nothing to read
    if (rn > MAX_ROWS + 1) fail(`Too many rows (the most is ${MAX_ROWS} people per import).`);
    rows[rn - 1] = filled; // kept at its row number, so messages say the same row as the spreadsheet
  }
  return Array.from(rows, r => r || []);
}

// ---------- people ----------
const norm = h => String(h || '').toLowerCase().replace(/[^a-z]/g, '');
const HEADER = {
  name: ['name', 'fullname', 'personname', 'employeename', 'employee'],
  email: ['email', 'emailaddress', 'emailid', 'mail', 'workemail'],
  team: ['team', 'department', 'dept', 'group'],
  role: ['role', 'position', 'type', 'accounttype']
};
function parsePeople(buf, fileName) {
  if (!Buffer.isBuffer(buf) || !buf.length) fail('The file is empty.');
  if (buf.length > MAX_BYTES) fail(`The file is too big (the most is ${MAX_BYTES / 1024 / 1024} MB).`);
  let table;
  if (buf[0] === 0x50 && buf[1] === 0x4b) table = parseXlsx(buf); // "PK": a zip, so .xlsx
  else if (buf.length > 4 && buf.readUInt32BE(0) === 0xd0cf11e0) fail('This is an old Excel file (.xls). In Excel choose Save As and pick “Excel Workbook (.xlsx)” or “CSV UTF-8”.');
  else table = parseCsv(decodeText(buf));
  if (!table.length) fail('The file is empty.');
  const head = table[0].map(norm), col = {};
  for (const [k, names] of Object.entries(HEADER)) col[k] = head.findIndex(h => names.includes(h));
  if (col.name < 0 || col.email < 0) fail('The first row must hold the column names: name, email, team, role (team and role may be left out). Use the template.');
  const rows = [];
  table.slice(1).forEach((r, i) => {
    const cell = k => (col[k] >= 0 ? String(r[col[k]] || '') : '').replace(/\s+/g, ' ').trim();
    const row = { line: i + 2, name: cell('name'), email: cell('email'), team: cell('team'), role: cell('role') };
    if (row.name || row.email || row.team || row.role) rows.push(row);
  });
  if (!rows.length) fail('The file has a header row but no people.');
  if (rows.length > MAX_ROWS) fail(`Too many rows (the most is ${MAX_ROWS} people per import).`);
  return { rows, columns: { team: col.team >= 0, role: col.role >= 0 } };
}

module.exports = { parsePeople, parseCsv, parseXlsx, MAX_BYTES, MAX_ROWS };
