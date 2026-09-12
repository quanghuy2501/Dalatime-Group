// Onicorn Admin Dashboard — reads existing /api/* endpoints only. No Google/DB writes happen here.
const $ = s => document.querySelector(s);
const fmt = n => Number(n || 0).toLocaleString('vi-VN');
const pct = n => { const x = Number(n || 0); return ((Math.abs(x) > 1 ? x / 100 : x) * 100).toFixed(2) + '%'; };
const esc = s => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = () => new Date().toISOString().slice(0, 10);
const fmtDate = s => { if (!s) return ''; const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(s).slice(0, 10); };
const isFuture = s => !!s && String(s).slice(0, 10) > todayStr();
// Posted dates in the future indicate bad source data (crawler/date-parse bug), not a real KPI — flag, don't hide.
const dateFlag = s => isFuture(s) ? ' <span class="pill warn" title="Ngày đăng nằm trong tương lai — dữ liệu nguồn cần kiểm tra">⚠ tương lai</span>' : '';

// Render may cold-start the service and establish a DB connection on the first request.
// Keep the real error visible while allowing that bounded startup window.
const REQUEST_TIMEOUT = 30000;
const TAB_LABELS = { overview: '🏠 Tổng quan', alerts: '🚨 Cần xử lý', brand: '🏷️ Thương hiệu', staff: '👥 Nhân sự', channel: '📡 Kênh', posts: '📝 Bài đăng', health: '🩺 Dữ liệu', links: '🏢 Khách hàng' };
const RANGE_PRESETS = [['7d', '7 ngày'], ['14d', '14 ngày'], ['30d', '30 ngày'], ['90d', '90 ngày'], ['all', 'Tất cả']];

let tab = (location.hash || '').replace('#', '');
if (!TAB_LABELS[tab]) tab = 'overview';
let range = { from: '', to: '', preset: 'all' };
let D = null;          // last known-good /api/dashboard payload
let hadData = false;   // true once we've successfully loaded at least once
let posts = null;
let postFilter = { q: '', brand: '', channel: '', staff: '', sort: 'view', dir: 'desc', limit: 50, offset: 0 };
let heatmapState = { key: '', status: 'idle', rows: [], error: '' };

function qs(extra = {}) {
  const p = new URLSearchParams();
  if (range.from) p.set('from', range.from);
  if (range.to) p.set('to', range.to);
  Object.entries(extra).forEach(([k, v]) => { if (v !== '' && v != null) p.set(k, v); });
  return p;
}

async function api(path, extra = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT);
  try {
    const r = await fetch(path + '?' + qs(extra), { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error((await r.text()) || `HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Hết thời gian chờ dữ liệu');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

function setStatus(state, text) {
  const dot = $('#statusDot');
  const label = $('#statusText');
  if (dot) dot.className = 'status-dot' + (state !== 'ok' ? ' ' + state : '');
  if (label) label.textContent = text;
}

function alertCount() {
  const a = D && D.alerts;
  if (!a) return 0;
  return (a.brandsDrop || []).length + (a.staffDrop || []).length + (a.sleepingChannels || []).length + (a.failedSync || []).length;
}

function nav() {
  const count = alertCount();
  $('#nav').innerHTML = Object.entries(TAB_LABELS).map(([k, v]) => {
    const badge = k === 'alerts' && count > 0 ? `<span class="badge">${count}</span>` : '';
    return `<button class="${k === tab ? 'active' : ''}" data-tab="${k}">${v}${badge ? ' ' + badge : ''}</button>`;
  }).join('');
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    tab = b.dataset.tab;
    try { history.replaceState(null, '', '#' + tab); } catch { /* ignore */ }
    render();
  });
}

function errorPanel(msg) {
  return `<div class="error-banner">⚠️ ${esc(msg)}<div><button class="button" id="retryBtn">Thử lại</button></div></div>`;
}

function table(rows, cols) {
  const body = (rows && rows.length)
    ? rows.map(r => `<tr>${cols.map(c => `<td>${typeof c[0] === 'function' ? c[0](r) : esc(r[c[0]])}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${cols.length}" class="empty">Không có dữ liệu</td></tr>`;
  return `<div class="table-wrap"><table><thead><tr>${cols.map(c => `<th>${c[1]}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function kpi(label, value, sub) {
  return `<div class="kpi"><label>${label}</label><strong>${value}</strong>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
}

function deltaPill(v) {
  if (v === null || v === undefined || !isFinite(v)) return '<span class="muted">—</span>';
  const r = Math.round(v * 10) / 10;
  if (Math.abs(r) < 0.5) return `<span class="delta flat">→ ${r}%</span>`;
  return r > 0 ? `<span class="delta up">↑ ${r}%</span>` : `<span class="delta down">↓ ${Math.abs(r)}%</span>`;
}

function chart(rows) {
  rows = rows || [];
  const max = Math.max(1, ...rows.map(x => Number(x.view) || 0));
  return `<div class="chart">${rows.map(x => {
    const future = isFuture(x.date);
    return `<div class="bar${future ? ' future' : ''}" style="height:${Math.max(2, Number(x.view || 0) / max * 195)}px" title="${esc(fmtDate(x.date))} · ${fmt(x.view)} view${future ? ' · ⚠ ngày tương lai' : ''}"></div>`;
  }).join('')}</div>`;
}

// ---- Range filter (presets + custom, never allows a future date) ----
function applyPreset(preset) {
  const today = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  range.preset = preset;
  if (preset === 'all') {
    range.from = ''; range.to = '';
  } else {
    const days = { '7d': 6, '14d': 13, '30d': 29, '90d': 89 }[preset];
    range.to = iso(today);
    range.from = iso(new Date(today.getTime() - days * 86400000));
  }
  postFilter.offset = 0; posts = null; load(true);
}

function applyCustomRange(from, to) {
  const today = todayStr();
  let f = from, t = to, adjusted = false;
  if (f && f > today) { f = today; adjusted = true; }
  if (t && t > today) { t = today; adjusted = true; }
  if (f && t && f > t) { [f, t] = [t, f]; adjusted = true; }
  if (adjusted) toast('Đã điều chỉnh khoảng ngày — không lọc theo ngày trong tương lai', 'error');
  range = { from: f, to: t, preset: 'custom' };
  postFilter.offset = 0; posts = null; load(true);
}

function rangeBar() {
  const today = todayStr();
  const label = range.from || range.to ? `${range.from || '…'} → ${range.to || '…'}` : 'toàn bộ dữ liệu';
  return `<div class="range-bar">
    <div class="range-chips">${RANGE_PRESETS.map(([k, v]) => `<button class="chip-btn ${range.preset === k ? 'on' : ''}" data-preset="${k}">${v}</button>`).join('')}</div>
    <div class="range-pick"><input type="date" id="rf" value="${esc(range.from)}" max="${today}"> → <input type="date" id="rt" value="${esc(range.to)}" max="${today}"> <button class="chip-btn on" id="rangeApply">Áp dụng</button></div>
    <div class="range-info">Lọc theo <b>ngày đăng bài</b> · ${label} — không nhận ngày trong tương lai.</div>
  </div>`;
}

// ---- Overview ----
function alertStrip() {
  const a = (D && D.alerts) || {};
  const chips = [];
  if ((a.failedSync || []).length) chips.push(`<span class="chip red" data-jump="health">🔴 <b>${a.failedSync.length}</b> job sync lỗi</span>`);
  if ((a.brandsDrop || []).length) chips.push(`<span class="chip orange" data-jump="alerts">🟠 <b>${a.brandsDrop.length}</b> thương hiệu tụt &gt;30%</span>`);
  if ((a.staffDrop || []).length) chips.push(`<span class="chip orange" data-jump="alerts">🟠 <b>${a.staffDrop.length}</b> nhân sự giảm hiệu suất</span>`);
  if ((a.sleepingChannels || []).length) chips.push(`<span class="chip yellow" data-jump="alerts">🟡 <b>${a.sleepingChannels.length}</b> kênh ngủ &gt;14 ngày</span>`);
  if (!chips.length) return `<div class="alert-strip ok">✅ Mọi thứ ổn — không có cảnh báo nào hiện tại.</div>`;
  return `<div class="alert-strip warn"><b>🚨 Cảnh báo:</b> ${chips.join('')}</div>`;
}

function actionList() {
  const a = (D && D.alerts) || {};
  const o = (D && D.overview) || {};
  const items = [];
  if ((a.failedSync || []).length) items.push({ icon: '🔴', text: `Xử lý ${a.failedSync.length} job đồng bộ bị lỗi`, jump: 'health', priority: 1 });
  if (Number(o.posts_7d) === 0) items.push({ icon: '🔴', text: 'Chưa có bài đăng nào trong 7 ngày gần nhất — kiểm tra crawler/lịch đăng', jump: 'health', priority: 1 });
  if ((a.brandsDrop || []).length) items.push({ icon: '🟠', text: `Liên hệ phụ trách ${a.brandsDrop.length} thương hiệu đang tụt hiệu suất`, jump: 'alerts', priority: 2 });
  if ((a.staffDrop || []).length) items.push({ icon: '🟠', text: `Xem lại ${a.staffDrop.length} nhân sự giảm hiệu suất`, jump: 'alerts', priority: 2 });
  if ((a.sleepingChannels || []).length) items.push({ icon: '🟡', text: `Khôi phục ${a.sleepingChannels.length} kênh chưa đăng bài trên 14 ngày`, jump: 'alerts', priority: 3 });
  items.sort((x, y) => x.priority - y.priority);
  return `<div class="panel todo-panel"><h2>🎯 Việc cần làm</h2>${items.length
    ? `<div class="todo-list">${items.map((it, i) => `<div class="todo-item"><span class="todo-num">${i + 1}</span><span class="todo-ico">${it.icon}</span><span class="todo-text">${esc(it.text)}</span><button class="todo-btn" data-jump="${it.jump}">Xem →</button></div>`).join('')}</div>`
    : '<p class="empty">✅ Không có việc gấp — tiếp tục theo dõi.</p>'}</div>`;
}

async function overview() {
  const o = D.overview || {};
  const a = D.alerts || {};
  let html = alertStrip() + rangeBar();
  html += `<div class="cards">
    ${kpi('Tổng view', fmt(o.view), 'Lượt xem hiện tại của bài trong kỳ')}
    ${kpi('Bài đăng', fmt(o.posts), 'Số bài trong kỳ đã chọn')}
    ${kpi('Bài viral', fmt(o.viral), o.posts ? `Chiếm ${(o.viral / o.posts * 100).toFixed(1)}% tổng bài` : 'Chưa có bài viral')}
    ${kpi('Bài độc quyền', fmt(o.exclusive), 'Gắn cờ độc quyền trong kỳ')}
    ${kpi('Tổng tương tác', fmt(o.interactions), 'Like + Cmt + Save + Share')}
    ${kpi('Engagement rate', pct(o.er), 'Tương tác / View')}
    ${kpi('Bài 7 ngày qua', fmt(o.posts_7d), `${fmt(o.view_7d)} view`)}
    ${kpi('Kênh hoạt động', fmt(o.active_channels), 'Số kênh có bài trong kỳ')}
  </div>`;
  html += actionList();
  html += `<div class="panel"><h2>📈 Xu hướng theo ngày đăng bài</h2>${chart(D.timeseries)}</div>`;
  html += `<div class="grid2">
    <div class="panel"><h2>🔥 Top bài trong 7 ngày</h2>${(a.trending || []).length ? table(a.trending, [
      [r => fmtDate(r.date) + dateFlag(r.date), 'Ngày'], ['brand', 'Thương hiệu'], ['channel', 'Kênh'], ['owner', 'Nhân sự'],
      [r => fmt(r.view), 'View'], [r => r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">Mở ↗</a>` : '', 'Link']
    ]) : '<p class="empty">Chưa có bài trong 7 ngày gần nhất</p>'}</div>
    <div class="panel"><h2>⚡ Top kênh viral</h2>${(a.topViralChannels || []).length ? table(a.topViralChannels, [['name', 'Kênh'], [r => fmt(r.viral), 'Số bài viral']]) : '<p class="empty">Chưa có bài viral</p>'}</div>
  </div>`;
  html += `<div class="grid2">
    <div class="panel"><h2>Top thương hiệu</h2>${table((D.brands || []).slice(0, 10), [['brand_name', 'Brand'], [r => fmt(r.posts), 'Bài'], [r => fmt(r.view), 'View'], [r => pct(r.er), 'ER']])}</div>
    <div class="panel"><h2>Top nhân sự</h2>${table((D.staff || []).slice(0, 10), [['staff_name', 'Nhân sự'], [r => fmt(r.posts), 'Bài'], [r => fmt(r.view), 'View'], [r => fmt(r.bonus_amount) + 'đ', 'Bonus']])}</div>
  </div>`;
  html += `<p class="footnote">KPI lọc theo <b>ngày đăng bài</b>. Mục Cảnh báo &amp; Dữ liệu luôn phản ánh trạng thái hiện tại, không theo khoảng ngày đang chọn.</p>`;
  return html;
}

// ---- Alerts ----
function alertsView() {
  const a = D.alerts || {};
  return `<div class="grid2">
    <div class="panel"><h2>📉 Thương hiệu tụt hiệu suất &gt;30%</h2>${table(a.brandsDrop, [['name', 'Thương hiệu'], [r => fmt(r.view), 'View 7d'], [r => fmt(r.viewPrev), '7d trước'], [r => deltaPill(r.change), 'Thay đổi']])}</div>
    <div class="panel"><h2>👤 Nhân sự giảm hiệu suất &gt;30%</h2>${table(a.staffDrop, [['name', 'Nhân sự'], [r => fmt(r.view), 'View 7d'], [r => fmt(r.viewPrev), '7d trước'], [r => deltaPill(r.change), 'Thay đổi']])}</div>
  </div>
  <div class="grid2">
    <div class="panel"><h2>💤 Kênh không đăng bài &gt;14 ngày</h2>${table(a.sleepingChannels, [['name', 'Kênh'], ['owner', 'Phụ trách'], [r => `<span class="pill bad">${fmt(r.lastPostDays)} ngày</span>`, 'Ngủ']])}</div>
    <div class="panel"><h2>⚠️ Lỗi đồng bộ dữ liệu</h2>${table(a.failedSync, [[r => r.timestamp ? new Date(r.timestamp).toLocaleString('vi-VN') : '', 'Thời điểm'], ['job', 'Job'], [r => `<span class="pill bad">${esc(r.status)}</span>`, 'Trạng thái'], ['error', 'Lỗi']])}</div>
  </div>`;
}

// ---- Brand / Staff / Channel ----
function heatmapRows(payload) {
  const rows = Array.isArray(payload) ? payload : (payload && (payload.rows || payload.data || payload.heatmap));
  return (Array.isArray(rows) ? rows : []).map(row => ({
    brand: String(row.brand ?? row.brand_name ?? ''),
    week: heatmapWeek(row.week ?? row.week_start ?? row.date),
    view: Number(row.view ?? row.views ?? row.value ?? 0)
  })).filter(row => row.brand && row.week && Number.isFinite(row.view));
}

function heatmapWeek(value) {
  const raw = String(value ?? '');
  if (!raw.includes('T')) return raw.slice(0, 10);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '';
  const part = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

function heatColor(value, max) {
  if (value <= 0 || max <= 0) return '#eef2f7';
  const strength = Math.sqrt(value / max);
  return `hsl(221 83% ${Math.round(96 - strength * 49)}%)`;
}

function heatTextColor(value, max) {
  return max > 0 && Math.sqrt(value / max) > .48 ? '#fff' : '#172033';
}

function heatmapPanel() {
  if (heatmapState.status === 'loading' || heatmapState.status === 'idle') return `<div class="panel heatmap-panel"><h2>Lượt xem theo thương hiệu và tuần</h2><div class="heatmap-state"><span class="spinner"></span><span>Đang tải dữ liệu heatmap…</span></div></div>`;
  if (heatmapState.status === 'error') return `<div class="panel heatmap-panel"><h2>Lượt xem theo thương hiệu và tuần</h2><div class="heatmap-state error-text">⚠️ ${esc(heatmapState.error)} <button class="button small" id="heatmapRetry">Thử lại</button></div></div>`;
  const rows = heatmapState.rows;
  if (!rows.length) return `<div class="panel heatmap-panel"><h2>Lượt xem theo thương hiệu và tuần</h2><div class="heatmap-state">Chưa có dữ liệu trong khoảng ngày đã chọn.</div></div>`;
  const weeks = [...new Set(rows.map(row => row.week))].sort();
  const brands = [...new Set(rows.map(row => row.brand))].sort((a, b) => a.localeCompare(b, 'vi'));
  const values = new Map(rows.map(row => [`${row.brand}\u0000${row.week}`, row.view]));
  const max = Math.max(0, ...rows.map(row => row.view));
  const cells = brands.map(brandName => `<div class="heatmap-label" title="${esc(brandName)}">${esc(brandName)}</div>${weeks.map(week => {
    const key = `${brandName}\u0000${week}`;
    const hasValue = values.has(key);
    const value = hasValue ? values.get(key) : 0;
    const title = `${brandName} · Tuần ${fmtDate(week)} · ${hasValue ? `${fmt(value)} lượt xem` : 'Không có dữ liệu'}`;
    return `<div class="heatmap-cell${hasValue ? '' : ' missing'}" style="background:${heatColor(value, max)};color:${heatTextColor(value, max)}" title="${esc(title)}" aria-label="${esc(title)}"><span>${hasValue ? fmt(value) : '—'}</span></div>`;
  }).join('')}`).join('');
  return `<div class="panel heatmap-panel"><div class="heatmap-heading"><h2>Lượt xem theo thương hiệu và tuần</h2><div class="heatmap-legend" aria-label="Thang màu lượt xem"><span>Thấp</span><i></i><span>Cao</span><em></em><span>Không có dữ liệu</span></div></div><p class="heatmap-note">Màu đậm hơn thể hiện nhiều lượt xem hơn. Di chuột hoặc chạm giữ để xem chi tiết.</p><div class="heatmap-scroll"><div class="heatmap-grid" style="--week-count:${weeks.length}"><div class="heatmap-corner">Thương hiệu</div>${weeks.map(week => `<div class="heatmap-week" title="Tuần bắt đầu ${fmtDate(week)}">${fmtDate(week)}</div>`).join('')}${cells}</div></div></div>`;
}

async function loadHeatmap(force = false) {
  const key = qs().toString();
  if (!force && heatmapState.key === key && ['loading', 'ready'].includes(heatmapState.status)) return;
  heatmapState = { key, status: 'loading', rows: [], error: '' };
  const host = $('#heatmapHost');
  if (host) host.innerHTML = heatmapPanel();
  try {
    heatmapState = { key, status: 'ready', rows: heatmapRows(await api('/api/heatmap')), error: '' };
  } catch (e) {
    heatmapState = { key, status: 'error', rows: [], error: 'Không tải được heatmap: ' + e.message };
  }
  if (tab === 'brand' && heatmapState.key === key) {
    const current = $('#heatmapHost');
    if (current) { current.innerHTML = heatmapPanel(); wireHeatmapRetry(); }
  }
}

function wireHeatmapRetry() {
  const retry = $('#heatmapRetry');
  if (retry) retry.onclick = () => loadHeatmap(true);
}

function brand() {
  return rangeBar() + `<div class="panel"><h2>Hiệu suất thương hiệu</h2>${table(D.brands, [
    ['brand_name', 'Brand'], [r => fmt(r.posts), 'Bài'], [r => fmt(r.view), 'View'], [r => pct(r.er), 'ER'], [r => fmt(r.viral), 'Viral'],
    [r => fmtDate(r.last_posted_date) + dateFlag(r.last_posted_date), 'Bài cuối']
  ])}</div><div id="heatmapHost">${heatmapPanel()}</div>`;
}
function staff() {
  return rangeBar() + `<div class="panel"><h2>Hiệu suất nhân sự</h2>${table(D.staff, [
    ['staff_name', 'Nhân sự'], [r => fmt(r.posts), 'Bài'], [r => fmt(r.view), 'View'], [r => pct(r.er), 'ER'], [r => fmt(r.viral), 'Viral'],
    [r => fmt(r.bonus_amount) + 'đ', 'Bonus'], [r => fmtDate(r.last_posted_date) + dateFlag(r.last_posted_date), 'Bài cuối']
  ])}</div>`;
}
function channel() {
  return rangeBar() + `<div class="panel"><h2>Hiệu suất kênh</h2>${table(D.channels, [
    ['channel_name', 'Kênh'], [r => fmt(r.posts), 'Bài'], [r => fmt(r.view), 'View'], [r => pct(r.er), 'ER'], [r => fmt(r.viral), 'Viral'],
    [r => fmtDate(r.last_posted_date) + dateFlag(r.last_posted_date), 'Bài cuối']
  ])}</div>`;
}

// ---- Posts (server-side filter/sort/paginate via /api/posts) ----
async function loadPosts() { posts = await api('/api/posts', postFilter); }

async function postsView() {
  if (!posts) await loadPosts();
  const total = posts.total || 0;
  const page = Math.floor(postFilter.offset / postFilter.limit) + 1;
  const pages = Math.max(1, Math.ceil(total / postFilter.limit));
  const sortLabel = { view: 'view', date: 'ngày', er: 'ER' };
  return rangeBar() + `<div class="panel"><h2>Bài đăng <small>${fmt(total)} bài</small></h2>
    <div class="filters">
      <input id="pq" placeholder="🔍 Tìm brand/kênh/NV/link" value="${esc(postFilter.q)}">
      <input id="pbrand" placeholder="Brand chứa..." value="${esc(postFilter.brand)}">
      <input id="pchannel" placeholder="Kênh (chính xác)" value="${esc(postFilter.channel)}">
      <input id="pstaff" placeholder="Nhân sự (chính xác)" value="${esc(postFilter.staff)}">
      <select id="psort">${Object.entries(sortLabel).map(([k, v]) => `<option value="${k}" ${postFilter.sort === k ? 'selected' : ''}>Sort ${v}</option>`).join('')}</select>
      <select id="pdir"><option value="desc" ${postFilter.dir === 'desc' ? 'selected' : ''}>Giảm dần</option><option value="asc" ${postFilter.dir === 'asc' ? 'selected' : ''}>Tăng dần</option></select>
      <button class="button primary" id="pApply">Lọc</button>
    </div>
    ${table(posts.rows, [
      [r => fmtDate(r.posted_date) + dateFlag(r.posted_date), 'Ngày'], ['brand_text_raw', 'Brand'], ['channel_name', 'Kênh'], ['owner_name', 'NV'],
      [r => fmt(r.realtime_view), 'View'], [r => fmt(r.realtime_like), 'Like'], [r => fmt(r.realtime_share), 'Share'], [r => pct(r.engagement_rate), 'ER'],
      [r => r.viral_label ? '<span class="pill">🔥 Viral</span>' : '', 'Viral'], [r => r.bonus_amount ? fmt(r.bonus_amount) + 'đ' : '', 'Bonus'],
      [r => r.post_url ? `<a href="${esc(r.post_url)}" target="_blank" rel="noopener">Mở ↗</a>` : '', 'Link']
    ])}
    <div class="pager"><span>Trang <b>${page}/${pages}</b></span>
      <button id="pPrev" ${page <= 1 ? 'disabled' : ''}>‹ Trước</button>
      <button id="pNext" ${page >= pages ? 'disabled' : ''}>Sau ›</button>
    </div>
  </div>`;
}

// ---- Health ----
function health() {
  const h = D.health || {};
  let html = `<div class="cards">
    ${kpi('Tổng dòng mirror', fmt(h.totalRows))}
    ${kpi('Thiếu ngày đăng', fmt(h.missingDate))}
    ${kpi('Thiếu link', fmt(h.missingLink))}
    ${kpi('Thiếu chỉ số', fmt(h.missingMetrics))}
  </div>`;
  html += `<div class="grid2">
    <div class="panel"><h2>Quality issues</h2>${table(h.summary, [
      [r => `<span class="pill ${r.severity === 'error' ? 'bad' : r.severity === 'warn' ? 'warn' : ''}">${esc(r.severity)}</span>`, 'Mức'],
      ['issue_type', 'Loại'], [r => fmt(r.count), 'Số lượng']
    ])}</div>
    <div class="panel"><h2>Sync runs</h2>${table(h.runs, [
      ['run_type', 'Job'], [r => `<span class="pill ${/fail/i.test(r.status) ? 'bad' : /partial/i.test(r.status) ? 'warn' : ''}">${esc(r.status)}</span>`, 'Trạng thái'],
      [r => fmt(r.rows_read), 'Đọc'], [r => fmt(r.rows_written), 'Ghi'], [r => r.finished_at ? new Date(r.finished_at).toLocaleString('vi-VN') : '', 'Hoàn tất']
    ])}</div>
  </div>`;
  return html;
}

// ---- Links / customer portal (kept visually consistent with the other tabs) ----
async function links() {
  const x = await api('/api/admin/report-links');
  return `<div class="panel"><h2>🏢 Khách hàng</h2><p class="muted">Bấm <b>Mở report</b> để xem báo cáo riêng của từng khách hàng.</p>${table(x.clients, [
    ['client_code', 'Mã KH'], ['name', 'Khách hàng'],
    [r => `<span class="pill ${r.active ? '' : 'neutral'}">${r.active ? 'Active' : 'Inactive'}</span>`, 'Trạng thái'],
    [r => `<span class="pill ${r.reportPath ? '' : 'neutral'}">${r.reportPath ? 'Đã cấu hình' : 'Chưa có'}</span>`, 'Key báo cáo'],
    [r => r.reportPath ? `<a class="button small" href="${esc(r.reportPath)}" target="_blank" rel="noopener">Mở report</a>` : '<span class="muted">—</span>', 'Báo cáo']
  ])}</div>`;
}

// ---- Render / event wiring ----
async function render() {
  nav();
  $('#title').textContent = TAB_LABELS[tab].replace(/^\S+\s/, '');
  $('#meta').textContent = D && D.status && D.status.lastSyncAt
    ? `Đồng bộ gần nhất: ${new Date(D.status.lastSyncAt).toLocaleString('vi-VN')}`
    : 'Đọc trực tiếp từ Supabase (chỉ đọc, không ghi Google Sheet)';
  if (!D) { $('#content').innerHTML = errorPanel('Chưa tải được dữ liệu dashboard.'); wireContentEvents(); return; }
  let html = '';
  try {
    if (tab === 'overview') html = await overview();
    else if (tab === 'alerts') html = alertsView();
    else if (tab === 'brand') html = brand();
    else if (tab === 'staff') html = staff();
    else if (tab === 'channel') html = channel();
    else if (tab === 'posts') html = await postsView();
    else if (tab === 'health') html = health();
    else if (tab === 'links') html = await links();
  } catch (e) {
    html = errorPanel('Không tải được mục này: ' + e.message);
  }
  $('#content').innerHTML = html;
  // Contain wide data tables inside their card instead of expanding the page.
  $('#content').querySelectorAll('table').forEach(tbl => {
    if (tbl.parentElement && !tbl.parentElement.classList.contains('table-wrap')) {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      tbl.parentElement.insertBefore(wrap, tbl);
      wrap.appendChild(tbl);
    }
  });
  // Charts should size to the grid track, not their intrinsic canvas width.
  $('#content').querySelectorAll('.chart, canvas').forEach(el => {
    const parent = el.closest('.panel') || el.parentElement;
    if (parent) parent.style.minWidth = '0';
  });
  wireContentEvents();
  if (tab === 'brand') loadHeatmap();
}

async function reRenderContent() {
  $('#content').classList.add('reloading');
  await render();
  $('#content').classList.remove('reloading');
}

function wireContentEvents() {
  document.querySelectorAll('[data-jump]').forEach(el => el.onclick = () => { tab = el.dataset.jump; render(); });
  document.querySelectorAll('[data-preset]').forEach(el => el.onclick = () => applyPreset(el.dataset.preset));
  const rangeApply = $('#rangeApply');
  if (rangeApply) rangeApply.onclick = () => applyCustomRange($('#rf').value, $('#rt').value);
  const retry = $('#retryBtn');
  if (retry) retry.onclick = () => load(true);
  wireHeatmapRetry();

  if (tab === 'posts') {
    const applyBtn = $('#pApply');
    if (applyBtn) applyBtn.onclick = () => {
      postFilter.q = $('#pq').value; postFilter.brand = $('#pbrand').value; postFilter.channel = $('#pchannel').value; postFilter.staff = $('#pstaff').value;
      postFilter.sort = $('#psort').value; postFilter.dir = $('#pdir').value; postFilter.offset = 0;
      posts = null; reRenderContent();
    };
    const prev = $('#pPrev');
    if (prev) prev.onclick = () => { postFilter.offset = Math.max(0, postFilter.offset - postFilter.limit); posts = null; reRenderContent(); };
    const next = $('#pNext');
    if (next) next.onclick = () => { postFilter.offset += postFilter.limit; posts = null; reRenderContent(); };
  }

  // Per-panel CSV export, in addition to the header "Tải CSV" button.
  document.querySelectorAll('#content .panel').forEach(p => {
    if (!p.querySelector('table') || p.querySelector('.csv-btn')) return;
    const h2 = p.querySelector('h2');
    if (!h2) return;
    const title = h2.textContent.trim();
    const btn = document.createElement('button');
    btn.className = 'csv-btn no-print';
    btn.textContent = '⬇ CSV';
    btn.onclick = () => exportTableCSV(p, title);
    h2.appendChild(btn);
  });
}

function exportTableCSV(scope, titleOverride) {
  const t = scope.querySelector('table');
  if (!t) { toast('Không có bảng dữ liệu để xuất', 'error'); return; }
  const rows = [...t.rows].map(tr => [...tr.cells].map(td => {
    let v = (td.innerText || '').replace(/\s+/g, ' ').trim();
    if (/[",\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
    return v;
  }).join(','));
  const base = (titleOverride || `dalat-time-${tab}`).replace(/[^\wÀ-ỹ-]/g, '_').slice(0, 60) || 'dalat-time';
  const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${base}_${todayStr()}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- Boot / refresh ----
async function load(isRetry) {
  setStatus('loading', 'Đang tải dữ liệu…');
  if (!hadData) {
    nav();
    $('#title').textContent = TAB_LABELS[tab].replace(/^\S+\s/, '');
    $('#content').innerHTML = `<div class="loading"><span class="spinner"></span>Đang tải dashboard…</div>`;
  }
  const [dashRes, statusRes] = await Promise.allSettled([api('/api/dashboard'), api('/api/status')]);
  if (dashRes.status === 'fulfilled') {
    D = dashRes.value;
    D.status = statusRes.status === 'fulfilled' ? statusRes.value : (D.status || {});
    hadData = true;
    setStatus('ok', 'Đã kết nối');
    if (isRetry) toast('Đã làm mới dữ liệu', 'ok');
  } else {
    setStatus('error', 'Mất kết nối API');
    toast('Lỗi tải dữ liệu: ' + dashRes.reason.message, 'error');
    // Keep the last known-good D on a failed refresh so the UI doesn't regress into misleading zeros.
  }
  posts = null;
  await render();
}

$('#refreshBtn').onclick = () => load(true);
$('#printBtn').onclick = () => window.print();
$('#exportBtn').onclick = () => exportTableCSV(document, `dalat-time-${tab}`);
window.addEventListener('hashchange', () => {
  const h = (location.hash || '').replace('#', '');
  if (TAB_LABELS[h] && h !== tab) { tab = h; render(); }
});

load();
