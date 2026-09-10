import { getServiceAccountAccessToken } from './serviceAccountAuth.mjs';

export class GoogleApi {
  constructor({ minDelayMs = 1250, maxRetries = 5 } = {}) {
    this.minDelayMs = minDelayMs;
    this.maxRetries = maxRetries;
    this.lastAt = 0;
    this.accessToken = null;
    this.serviceAccountEmail = null;
  }
  async init() {
    const auth = await getServiceAccountAccessToken();
    this.accessToken = auth.accessToken;
    this.serviceAccountEmail = auth.serviceAccountEmail;
    this.projectId = auth.projectId;
    return this;
  }
  async waitTurn() {
    const now = Date.now();
    const wait = Math.max(0, this.lastAt + this.minDelayMs - now);
    if (wait) await new Promise(r => setTimeout(r, wait));
    this.lastAt = Date.now();
  }
  async fetchJson(url, opts = {}) {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.waitTurn();
      let res;
      try {
        res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${this.accessToken}`, 'content-type': 'application/json', ...(opts.headers || {}) } });
      } catch (e) {
        if (attempt < this.maxRetries) {
          const backoff = Math.min(60000, 2000 * Math.pow(2, attempt));
          await new Promise(r => setTimeout(r, backoff));
          continue;
        }
        throw e;
      }
      const text = await res.text();
      let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (res.ok) return json;
      const retryAfter = Number(res.headers.get('retry-after') || 0);
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const backoff = retryAfter ? retryAfter * 1000 : Math.min(60000, 2000 * Math.pow(2, attempt));
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw new Error(`HTTP ${res.status} ${url}: ${JSON.stringify(json).slice(0, 1000)}`);
    }
  }
  async listFolder(folderId) {
    const files = []; let pageToken = '';
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
      const fields = encodeURIComponent('nextPageToken, files(id,name,mimeType,webViewLink,modifiedTime,owners(displayName,emailAddress),size)');
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}&supportsAllDrives=true&includeItemsFromAllDrives=true`;
      const j = await this.fetchJson(url);
      files.push(...(j.files || [])); pageToken = j.nextPageToken || '';
    } while (pageToken);
    return files;
  }
  async spreadsheetMeta(id) {
    const fields = encodeURIComponent('spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index,gridProperties(rowCount,columnCount,frozenRowCount,columnCount)))');
    return this.fetchJson(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=${fields}`);
  }
  async values(id, range) {
    return this.fetchJson(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
  }
  async batchValues(id, ranges) {
    const qs = ranges.map(r => `ranges=${encodeURIComponent(r)}`).join('&');
    return this.fetchJson(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${qs}&majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
  }
}
