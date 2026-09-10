export async function ensureSheet(api, spreadsheetId, title) {
  const meta = await api.spreadsheetMeta(spreadsheetId);
  const existing = meta.sheets.find(s => s.properties.title === title);
  if (existing) return existing.properties.sheetId;
  const res = await api.fetchJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] })
  });
  return res.replies?.[0]?.addSheet?.properties?.sheetId;
}

export async function resizeSheet(api, spreadsheetId, sheetId, rowCount, columnCount) {
  await api.fetchJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount, columnCount } }, fields: 'gridProperties.rowCount,gridProperties.columnCount' } }] })
  });
}

export async function clearSheet(api, spreadsheetId, title) {
  await api.fetchJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`'${title.replaceAll("'", "''")}'`)}:clear`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function writeValues(api, spreadsheetId, title, rows, { chunkSize = 2000 } = {}) {
  const safe = title.replaceAll("'", "''");
  let written = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const startRow = i + 1;
    const range = `'${safe}'!A${startRow}`;
    await api.fetchJson(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, {
      method: 'PUT',
      body: JSON.stringify({ range, majorDimension: 'ROWS', values: chunk })
    });
    written += chunk.length;
  }
  return written;
}
