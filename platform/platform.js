/* ============================================================
   DeepSeek 开放平台面板 — 渲染进程逻辑
   ============================================================ */

'use strict';

const api = window.dshPlatform;
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));

let STATE = { key: { present: false, masked: '', source: 'none' }, secure: true };
let MODELS = [];

/* ---------------- 工具 ---------------- */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 极简 Markdown：代码块 / 行内代码 / 粗体（先转义再处理，避免注入）
function renderRich(text) {
  let h = escapeHtml(text);
  h = h.replace(/```([a-zA-Z0-9+#-]*)\n?([\s\S]*?)```/g, (_m, _lang, code) =>
    '<pre><code>' + code.replace(/\n$/, '') + '</code></pre>');
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  return h;
}

function fmtNum(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('zh-CN');
}

function fmtTokens(n) {
  if (!n) return '';
  if (n >= 10000) return (n / 10000).toFixed(1) + ' 万';
  return String(n);
}

let toastTimer;
function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------------- 顶栏状态 ---------------- */

function renderKeyStatus() {
  const el = $('#keyStatus');
  const text = $('#keyStatusText');
  const k = STATE.key || {};
  el.classList.remove('ok', 'bad');
  if (k.present) {
    el.classList.add('ok');
    const src = k.source === 'dsh' ? 'DSH 凭据' : '已保存';
    text.innerHTML = `<code>${escapeHtml(k.masked)}</code> · ${src}`;
    el.title = '密钥来源：' + src;
  } else {
    el.classList.add('bad');
    text.textContent = '未配置 API 密钥';
    el.title = '请到「设置」里填写，或从 DSH 凭据导入';
  }
}

/* ---------------- 概览：余额 ---------------- */

async function loadBalance() {
  const box = $('#balanceBody');
  box.innerHTML = '<p class="hint"><span class="spin">◐</span> 正在查询余额…</p>';
  const res = await api.balance();

  if (!res.ok) {
    box.innerHTML = `<div class="notice warn">${escapeHtml(res.error || '查询失败')}</div>` +
      '<p class="hint">请到「设置」检查 API 密钥。</p>';
    return;
  }

  const d = res.data || {};
  const infos = d.balance_infos || [];
  if (!infos.length) {
    box.innerHTML = '<div class="notice warn">接口未返回余额信息。</div>';
    return;
  }

  const primary = infos[0];
  const cur = primary.currency === 'USD' ? '$' : '¥';
  const rows = infos.map((b) => {
    const c = b.currency === 'USD' ? '$' : '¥';
    return `<div class="kv"><span>${escapeHtml(b.currency)} 充值余额</span><b>${c} ${escapeHtml(b.topped_up_balance)}</b></div>
            <div class="kv"><span>${escapeHtml(b.currency)} 赠金余额</span><b>${c} ${escapeHtml(b.granted_balance)}</b></div>`;
  }).join('');

  const low = parseFloat(primary.total_balance) < 5;

  box.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
      <span class="pill ${d.is_available ? 'ok' : 'bad'}">${d.is_available ? '● 可用于调用' : '● 余额不足'}</span>
      ${low && d.is_available ? '<span class="pill warn">余额偏低</span>' : ''}
    </div>
    <div class="balance-main">
      <span class="balance-value">${cur} ${escapeHtml(primary.total_balance)}</span>
      <span class="balance-cur">总可用余额</span>
    </div>
    ${rows}
    <p class="hint">查询时间 ${new Date().toLocaleTimeString('zh-CN')}</p>`;
}

/* ---------------- 概览：模型 ---------------- */

async function loadModels() {
  const box = $('#modelsBody');
  box.innerHTML = '<p class="hint"><span class="spin">◐</span> 正在获取模型…</p>';
  const res = await api.models();

  if (!res.ok) {
    box.innerHTML = `<div class="notice warn">${escapeHtml(res.error || '获取失败')}</div>`;
    return;
  }

  MODELS = (res.data && res.data.data) || [];
  if (!MODELS.length) {
    box.innerHTML = '<p class="hint">接口未返回模型。</p>';
    return;
  }

  box.innerHTML = MODELS.map((m) => {
    const levels = (m.effort && m.effort.supported_levels) || [];
    const inputs = (m.input_modalities || []).join(' + ') || 'text';
    return `
      <div class="model">
        <div class="model-icon">${escapeHtml((m.name || m.id || '?').slice(0, 2))}</div>
        <div class="model-body">
          <div class="model-name">${escapeHtml(m.name || m.id)}
            <span class="model-id">${escapeHtml(m.id)}</span></div>
          <div class="model-meta">
            <span>上下文 <b>${fmtTokens(m.context_window)}</b></span>
            <span>最大输出 <b>${fmtTokens(m.max_output_tokens)}</b></span>
            <span>输入 <b>${escapeHtml(inputs)}</b></span>
            ${levels.length ? `<span>思考档位 <b>${escapeHtml(levels.join(' / '))}</b></span>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  renderModelSelect();
}

/* ---------------- 对话测试 ---------------- */

let messages = [];        // {role, content, reasoning?}
let streaming = false;
let currentStreamId = null;
let usageTotals = { prompt: 0, completion: 0, calls: 0 };

function renderModelSelect() {
  const sel = $('#modelSelect');
  const prev = sel.value;
  sel.innerHTML = MODELS.map((m) =>
    `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name || m.id)}</option>`).join('');
  if (prev && MODELS.some((m) => m.id === prev)) sel.value = prev;
  syncEffortOptions();
}

// 按所选模型能力裁剪「推理强度」下拉
function syncEffortOptions() {
  const model = MODELS.find((m) => m.id === $('#modelSelect').value);
  const sel = $('#effortSelect');
  const levels = (model && model.effort && model.effort.supported_levels) || [];
  const prev = sel.value;
  const opts = ['<option value="">默认</option>', '<option value="none">none（关闭思考）</option>']
    .concat(levels.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`));
  sel.innerHTML = opts.join('');
  if (prev && Array.prototype.some.call(sel.options, (o) => o.value === prev)) sel.value = prev;
  else if (model && model.effort && model.effort.default_level) sel.value = model.effort.default_level;
}

function chatEmpty() {
  return `<div class="chat-empty"><span class="big">💬</span>
    直接用你的 API 密钥测试模型<br>Enter 发送 · Shift+Enter 换行 · 生成中可随时停止</div>`;
}

function renderChat() {
  const log = $('#chatLog');
  if (!messages.length && !streaming) { log.innerHTML = chatEmpty(); return; }

  log.innerHTML = messages.map((m, i) => {
    const isUser = m.role === 'user';
    const think = m.reasoning
      ? `<details class="think"${streaming && i === messages.length - 1 ? ' open' : ''}><summary>思考过程</summary>${escapeHtml(m.reasoning)}</details>`
      : '';
    const body = isUser ? escapeHtml(m.content) : renderRich(m.content);
    return `<div class="msg ${isUser ? 'user' : 'assistant'}">
      <div class="avatar">${isUser ? '你' : 'DS'}</div>
      <div class="bubble">${think}${body || (streaming && i === messages.length - 1 ? '<span class="spin">◐</span>' : '')}</div>
    </div>`;
  }).join('');

  log.scrollTop = log.scrollHeight;
}

async function send() {
  if (streaming) return;

  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;

  if (!STATE.key.present) {
    toast('请先在「设置」里配置 API 密钥', 'err');
    switchTab('settings');
    return;
  }

  messages.push({ role: 'user', content: text });
  input.value = '';
  autoGrow();

  const assistant = { role: 'assistant', content: '', reasoning: '' };
  messages.push(assistant);

  streaming = true;
  setComposerBusy(true);
  $('#chatStatus').textContent = '正在生成…';
  renderChat();

  const payload = {
    model: $('#modelSelect').value,
    effort: $('#effortSelect').value,
    temperature: parseFloat($('#tempInput').value),
    messages: messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }))
  };

  const res = await api.chatStart(payload);
  if (!res.ok) {
    streaming = false;
    setComposerBusy(false);
    messages.pop();
    messages.pop();
    renderChat();
    $('#chatStatus').textContent = '出错';
    toast(res.error || '请求失败', 'err');
    return;
  }
  currentStreamId = res.streamId;
}

function setComposerBusy(busy) {
  $('#sendBtn').disabled = busy;
  $('#sendBtn').innerHTML = busy
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg> 停止'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"></path></svg> 发送';
  $('#chatInput').disabled = false;
}

// 流式增量
api.onChatChunk((ev) => {
  if (!ev || ev.streamId !== currentStreamId) return;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return;

  if (ev.type === 'delta') {
    if (ev.reasoning) last.reasoning += ev.reasoning;
    if (ev.content) last.content += ev.content;
    renderChat();
  } else if (ev.type === 'usage') {
    usageTotals.prompt += ev.prompt_tokens || 0;
    usageTotals.completion += ev.completion_tokens || 0;
    usageTotals.calls += 1;
    $('#usageText').textContent =
      `本次会话：${usageTotals.calls} 次调用 · 输入 ${fmtTokens(usageTotals.prompt)} · 输出 ${fmtTokens(usageTotals.completion)} tokens`;
  } else if (ev.type === 'done') {
    finishStream('完成');
  } else if (ev.type === 'error') {
    finishStream('出错');
    toast(ev.message || '生成失败', 'err');
  }
});

function finishStream(statusText) {
  streaming = false;
  currentStreamId = null;
  setComposerBusy(false);
  $('#chatStatus').textContent = statusText || '就绪';
  // 去掉空的思考块
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant' && !last.reasoning) delete last.reasoning;
  renderChat();
}

async function stop() {
  if (!streaming) return;
  await api.chatAbort(currentStreamId);
  finishStream('已停止');
}

function autoGrow() {
  const t = $('#chatInput');
  t.style.height = 'auto';
  t.style.height = Math.min(Math.max(t.scrollHeight, 52), 180) + 'px';
}

/* ---------------- 设置 ---------------- */

function renderSettings() {
  const secure = STATE.secure;
  const k = STATE.key || {};
  $('#settingsNotice').innerHTML = secure
    ? '<div class="notice ok">密钥会用 Windows DPAPI 加密后保存在本机，不会明文落盘。</div>'
    : '<div class="notice warn">当前系统不支持 DPAPI 加密，密钥将以明文保存在配置文件中，请注意安全。</div>';

  const srcText = { dsh: 'DSH 凭据（~/.dsh/.credentials.yaml）', saved: '本应用已保存', none: '未配置' }[k.source || 'none'];
  $('#keySourceText').textContent = srcText;
  $('#storeHint').innerHTML = k.present
    ? `当前密钥：<code>${escapeHtml(k.masked)}</code> · 来源：${escapeHtml(srcText)}`
    : '还没有可用的密钥。可以点「从 DSH 凭据导入」一键读取，或手动粘贴。';
}

/* ---------------- 交互绑定 ---------------- */

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  $$('.page').forEach((p) => p.classList.toggle('is-active', p.id === 'page-' + name));
}

function bind() {
  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // 外链交给系统浏览器
  $$('[data-open]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    api.openExternal(a.dataset.open);
  }));

  $('#refreshBtn').addEventListener('click', refreshAll);

  // 切换到 DeepSeek Harness（对端窗口会被唤起，本窗口隐藏）
  $('#toHarnessBtn').addEventListener('click', () => api.switchView('harness'));

  // Ctrl+Shift+P 也能切
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
      e.preventDefault();
      api.switchView('harness');
    }
  });

  // 对话
  $('#sendBtn').addEventListener('click', () => (streaming ? stop() : send()));
  const input = $('#chatInput');
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $('#modelSelect').addEventListener('change', syncEffortOptions);
  $('#clearChatBtn').addEventListener('click', () => {
    if (streaming) return;
    messages = [];
    usageTotals = { prompt: 0, completion: 0, calls: 0 };
    $('#usageText').textContent = '';
    $('#chatStatus').textContent = '就绪';
    renderChat();
  });
  $('#copyChatBtn').addEventListener('click', async () => {
    const text = messages.map((m) => (m.role === 'user' ? '我：' : 'AI：') + m.content).join('\n\n');
    try { await navigator.clipboard.writeText(text); toast('已复制对话', 'ok'); }
    catch (e) { toast('复制失败', 'err'); }
  });

  // 设置
  $('#saveKeyBtn').addEventListener('click', async () => {
    const key = $('#keyInput').value.trim();
    if (!key) { toast('请先粘贴密钥', 'err'); return; }
    const res = await api.saveKey(key);
    if (res.ok) {
      $('#keyInput').value = '';
      await refreshState();
      toast('密钥已保存', 'ok');
      refreshAll();
    } else {
      toast(res.error || '保存失败', 'err');
    }
  });

  $('#importKeyBtn').addEventListener('click', async () => {
    const res = await api.importKey();
    if (res.ok) {
      await refreshState();
      toast('已从 DSH 凭据导入并保存', 'ok');
      refreshAll();
    } else {
      toast(res.error || '导入失败', 'err');
    }
  });

  $('#clearKeyBtn').addEventListener('click', async () => {
    await api.clearKey();
    await refreshState();
    toast('已清除本应用保存的密钥');
  });

  $('#testKeyBtn').addEventListener('click', async () => {
    const typed = $('#keyInput').value.trim();
    $('#testKeyBtn').disabled = true;
    const res = await api.testKey(typed || null);
    $('#testKeyBtn').disabled = false;
    if (res.ok) toast(`连接正常，可用模型 ${res.count} 个`, 'ok');
    else toast(res.error || '连接失败', 'err');
  });
}

/* ---------------- 启动 ---------------- */

async function refreshState() {
  STATE = await api.state();
  renderKeyStatus();
  renderSettings();
}

async function refreshAll() {
  await refreshState();
  await Promise.all([loadBalance(), loadModels()]);
}

async function init() {
  try {
    const icon = await api.appIcon();
    if (icon) $('#appLogo').src = icon;
  } catch (e) { /* 图标失败不影响功能 */ }

  bind();
  renderChat();

  // 菜单里点了「开放平台 → 某个页签」时切过去
  if (api.onSwitchTab) api.onSwitchTab((tab) => { if (tab) switchTab(tab); });

  await refreshAll();
}

init();
