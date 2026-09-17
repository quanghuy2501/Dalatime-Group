/** Minimal signed control bridge. It contains no CONFIG copy or business logic. */
const RENDER_ACTIONS = Object.freeze({
  'Đẩy CONFIG tới NV': 'config_push'
});

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Đồng bộ')
    .addItem('Đẩy CONFIG tới NV', 'syncConfigToNv')
    .addSeparator()
    .addItem('Kiểm tra trạng thái', 'checkRenderStatus')
    .addToUi();
}

function syncConfigToNv() { return enqueueRenderSync_('config_push'); }

// Assign this function to a Sheet drawing/button if one-click access is desired.
function syncButton() { return syncConfigToNv(); }

function checkRenderStatus() {
  const response = callRenderWebhook_('status', null);
  const data = response.data;
  const queue = data.queue || {};
  const jobs = data.jobs || {};
  const lines = [
    `Dịch vụ: ${data.service === 'ok' ? 'hoạt động' : 'không xác định'}`,
    `Cơ sở dữ liệu: ${data.database === 'ready' ? 'sẵn sàng' : 'không sẵn sàng'}`,
    `Hàng đợi: ${safeCount_(queue.queued)} chờ, ${safeCount_(queue.running)} đang chạy`,
    `Công việc: ${safeCount_(jobs.total)} tổng, ${safeCount_(jobs.succeeded)} thành công, ${safeCount_(jobs.failed)} lỗi`,
    `Thành công gần nhất: ${safeDate_(jobs.latestSuccessAt)}`
  ];
  SpreadsheetApp.getUi().alert('Trạng thái Render', lines.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}

function enqueueRenderSync_(action) {
  if (Object.values(RENDER_ACTIONS).indexOf(action) === -1) throw new Error('Tác vụ không được phép.');
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('Xác nhận', 'Tác vụ sẽ được xếp hàng và có thể ghi dữ liệu production. Tiếp tục?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  const idempotencyKey = `${action}:${Utilities.getUuid()}`;
  callRenderWebhook_(action, idempotencyKey);
  ui.alert('Đã xếp hàng', 'Theo dõi tiến độ tại Dashboard → Đồng bộ.', ui.ButtonSet.OK);
}

function callRenderWebhook_(action, idempotencyKey) {
  const allowed = Object.values(RENDER_ACTIONS).concat(['status']);
  if (allowed.indexOf(action) === -1) throw new Error('Tác vụ không được phép.');
  const props = PropertiesService.getScriptProperties();
  const baseUrl = String(props.getProperty('RENDER_ADMIN_BASE_URL') || '').replace(/\/$/, '');
  const secret = props.getProperty('RENDER_ADMIN_WEBHOOK_SECRET');
  if (!/^https:\/\//.test(baseUrl) || !secret) throw new Error('Thiếu cấu hình bridge trong Script Properties.');
  const timestamp = String(Date.now());
  const payload = { action: action };
  if (idempotencyKey) payload.idempotencyKey = idempotencyKey;
  const body = JSON.stringify(payload);
  const bytes = Utilities.computeHmacSha256Signature(`${timestamp}.${body}`, secret);
  const signature = bytes.map(function(byte) { const value = byte < 0 ? byte + 256 : byte; return (`0${value.toString(16)}`).slice(-2); }).join('');
  const response = UrlFetchApp.fetch(`${baseUrl}/api/admin/sync/webhook`, {
    method: 'post', contentType: 'application/json', payload: body, muteHttpExceptions: true,
    headers: Object.assign({ 'X-Sync-Timestamp': timestamp, 'X-Sync-Signature': signature }, idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(formatRenderError_(code, response.getContentText()));
  }
  let data;
  try { data = JSON.parse(response.getContentText()); } catch (_error) { throw new Error('Render trả về dữ liệu không hợp lệ.'); }
  if (!data || data.ok !== true) throw new Error('Render không xác nhận yêu cầu.');
  return { code: code, data: data };
}

function formatRenderError_(httpCode, responseText) {
  const details = {};
  try {
    const parsed = JSON.parse(String(responseText || ''));
    ['error', 'reason', 'code'].forEach(function(key) {
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, key)) {
        const value = parsed[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') details[key] = String(value);
      }
    });
  } catch (_error) {
    // Do not expose a raw response body. The HTTP status is still useful below.
  }
  const fields = Object.keys(details).map(function(key) { return `${key}: ${details[key]}`; });
  return `Render từ chối yêu cầu (HTTP ${httpCode})${fields.length ? ` - ${fields.join('; ')}` : '.'}`;
}

function safeCount_(value) { const count = Number(value); return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0; }
function safeDate_(value) { if (!value) return 'chưa có'; const date = new Date(value); return isNaN(date.getTime()) ? 'không xác định' : date.toLocaleString('vi-VN'); }
