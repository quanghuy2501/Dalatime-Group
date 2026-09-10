import fs from 'fs';

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i], nx = text[i + 1];
    if (q) {
      if (ch === '"' && nx === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else {
      if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function readCsv(path) {
  return parseCsv(fs.readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

export function nonEmptyRows(rows) {
  return rows.filter(r => r.some(c => String(c ?? '').trim()));
}
