/** Minimal signed control bridge. It contains no CONFIG copy or business logic. */
const RENDER_ACTIONS = Object.freeze({
  'Đẩy CONFIG tới NV': 'config_push',
  'Đồng bộ NV vào DB': 'direct_nv_sync',
  'Làm mới / đối soát report': 'report_refresh_reconcile',
  'Chạy toàn bộ pipeline': 'full_pipeline'
});

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Đồng bộ')
    .addItem('Đẩy CONFIG tới NV', 'syncConfigToNv')
    .addItem('Đồng bộ NV vào DB', 'syncNvToDb')
    .addItem('Làm mới / đối soát report', 'syncReports')
    .addSeparator()
    .addItem('Chạy toàn bộ pipeline', 'syncFullPipeline')
    .addToUi();
}

function syncConfigToNv() { return enqueueRenderSync_('config_push'); }
function syncNvToDb() { return enqueueRenderSync_('direct_nv_sync'); }
function syncReports() { return enqueueRenderSync_('report_refresh_reconcile'); }
function syncFullPipeline() { return enqueueRenderSync_('full_pipeline'); }

// Assign this function to a Sheet drawing/button if one-click access is desired.
function syncButton() { return syncFullPipeline(); }

function enqueueRenderSync_(action) {
  if (Object.values(RENDER_ACTIONS).indexOf(action) === -1) throw new Error('Tác vụ không được phép.');
  const ui = SpreadsheetApp.getUi();
  if (ui.alert('Xác nhận', 'Tác vụ sẽ được xếp hàng và có thể ghi dữ liệu production. Tiếp tục?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
  const props = PropertiesService.getScriptProperties();
  const baseUrl = String(props.getProperty('RENDER_ADMIN_BASE_URL') || '').replace(/\/$/, '');
  const secret = props.getProperty('RENDER_ADMIN_WEBHOOK_SECRET');
  if (!/^https:\/\//.test(baseUrl) || !secret) throw new Error('Thiếu cấu hình bridge trong Script Properties.');
  const timestamp = String(Date.now());
  const idempotencyKey = `${action}:${Utilities.getUuid()}`;
  const body = JSON.stringify({ action: action, idempotencyKey: idempotencyKey });
  const bytes = Utilities.computeHmacSha256Signature(`${timestamp}.${body}`, secret);
  const signature = bytes.map(function(byte) { const value = byte < 0 ? byte + 256 : byte; return (`0${value.toString(16)}`).slice(-2); }).join('');
  const response = UrlFetchApp.fetch(`${baseUrl}/api/admin/sync/webhook`, {
    method: 'post', contentType: 'application/json', payload: body, muteHttpExceptions: true,
    headers: { 'X-Sync-Timestamp': timestamp, 'X-Sync-Signature': signature, 'Idempotency-Key': idempotencyKey }
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new Error(`Render từ chối yêu cầu (HTTP ${code}).`);
  ui.alert('Đã xếp hàng', 'Theo dõi tiến độ tại Dashboard → Đồng bộ.', ui.ButtonSet.OK);
}
