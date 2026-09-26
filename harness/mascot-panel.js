/* ============================================================
   Q 版助手：注入到 DSH 页面左侧栏的完整角色
   —— 用户提供的全身 Q 版立绘（已抠透明底）：整身动画 + 可拖动 + 提醒气泡
   由 main.js 读成字符串后 executeJavaScript 注入。
   ============================================================ */

(async function () {
  var ID = 'dsh-mascot-panel';
  var old = document.getElementById(ID);
  if (old) old.remove();
  if (!window.dshSwitch) return 'no-bridge';

  var stats = null, parts = null;
  try { stats = await window.dshSwitch.stats(); } catch (e) { stats = null; }
  try { parts = await window.dshSwitch.mascot(); } catch (e) { parts = null; }
  if (!parts || !parts.full) return 'no-mascot';

  var W = 140;                          // 角色显示宽度
  var H = Math.round(W * 431 / 300);    // 素材 300×431

  function money(v, cur) {
    if (v === null || v === undefined || isNaN(Number(v))) return '—';
    return (cur === 'USD' ? '$' : '¥') + Number(v).toFixed(2);
  }
  function readTokens() {
    var el = document.querySelector('[data-composer-stats]');
    if (!el) return '';
    return (el.innerText || '').replace(/\s+/g, ' ').trim();
  }

  /* ---------- 样式（只插一次） ---------- */
  if (!document.getElementById('dsh-mascot-style')) {
    var style = document.createElement('style');
    style.id = 'dsh-mascot-style';
    style.textContent = [
      '@keyframes dshFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}',
      '@keyframes dshBreathe{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.014)}}',
      '@keyframes dshSway{0%,100%{transform:rotate(-1.1deg)}50%{transform:rotate(1.1deg)}}',
      '@keyframes dshShadow{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(.84);opacity:.5}}',
      '@keyframes dshHop{0%{transform:translateY(0)}35%{transform:translateY(-14px) scale(1.03)}70%,100%{transform:translateY(0)}}',

      '#dsh-mascot-panel{position:fixed;z-index:2147482900;user-select:none;cursor:grab;width:' + W + 'px;',
      '  font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
      '#dsh-mascot-panel.dragging{cursor:grabbing}',
      '#dsh-mascot-panel .float{animation:dshFloat 3.6s ease-in-out infinite;',
      '  filter:drop-shadow(0 10px 16px rgba(40,60,120,.24))}',
      '#dsh-mascot-panel.hop .float{animation:dshHop .62s ease-out}',
      '#dsh-mascot-panel .sway{animation:dshSway 5.2s ease-in-out infinite;transform-origin:50% 100%}',
      '#dsh-mascot-panel .char{display:block;width:' + W + 'px;height:' + H + 'px;',
      '  animation:dshBreathe 3.6s ease-in-out infinite;transform-origin:50% 100%}',
      '#dsh-mascot-panel .shadow{width:' + Math.round(W * 0.56) + 'px;height:11px;margin:-4px auto 0;border-radius:50%;',
      '  background:radial-gradient(closest-side,rgba(40,60,120,.34),rgba(40,60,120,0));',
      '  animation:dshShadow 3.6s ease-in-out infinite}',

      '#dsh-mascot-panel .bubble{position:absolute;left:2px;bottom:calc(100% + 6px);width:200px;',
      '  background:#fff;border:1px solid #e3e8f2;border-radius:13px;padding:8px 10px;',
      '  box-shadow:0 12px 28px -14px rgba(31,41,55,.35);font-size:11.5px;line-height:1.6;color:#5b6478;',
      '  transition:opacity .3s ease,transform .3s ease;opacity:0;transform:translateY(5px);pointer-events:none}',
      '#dsh-mascot-panel .bubble.show{opacity:1;transform:translateY(0)}',
      '#dsh-mascot-panel .bubble .say{color:#1f2937;margin-bottom:4px}',
      '#dsh-mascot-panel .bubble .row{display:flex;justify-content:space-between;gap:8px}',
      '#dsh-mascot-panel .bubble .row b{font-weight:600;font-variant-numeric:tabular-nums}',
      '#dsh-mascot-panel .tip{text-align:center;font-size:10px;color:#9aa4b8;opacity:0;transition:opacity .3s}',
      '#dsh-mascot-panel:hover .tip{opacity:1}'
    ].join('\n');
    document.head.appendChild(style);
  }

  /* ---------- DOM ---------- */
  var box = document.createElement('div');
  box.id = ID;

  var bubble = document.createElement('div');
  bubble.className = 'bubble';
  var say = document.createElement('div');
  say.className = 'say';
  bubble.appendChild(say);
  function row(label) {
    var d = document.createElement('div');
    d.className = 'row';
    var l = document.createElement('span'); l.textContent = label;
    var v = document.createElement('b'); v.textContent = '—';
    d.appendChild(l); d.appendChild(v);
    bubble.appendChild(d);
    return v;
  }
  var vBal = row('余额');
  var vRun = row('本次消耗');
  var vTok = row('Tokens');
  vBal.style.color = '#4a6cf7';
  vRun.style.color = '#e0632f';
  vTok.style.color = '#2f8f6b';
  box.appendChild(bubble);

  var float = document.createElement('div');
  float.className = 'float';
  var sway = document.createElement('div');
  sway.className = 'sway';
  var char = document.createElement('img');
  char.className = 'char';
  char.src = parts.full;
  char.alt = 'DSH 助手';
  sway.appendChild(char);
  float.appendChild(sway);
  box.appendChild(float);

  var shadow = document.createElement('div');
  shadow.className = 'shadow';
  box.appendChild(shadow);

  var tip = document.createElement('div');
  tip.className = 'tip';
  tip.textContent = '拖动我可以换位置';
  box.appendChild(tip);

  /* ---------- 位置（记住拖动结果） ---------- */
  var POS_KEY = 'dsh-mascot-pos';
  var boxH = H + 16;
  function applyPos(left, top) {
    left = Math.max(0, Math.min(left, window.innerWidth - W));
    top = Math.max(0, Math.min(top, window.innerHeight - boxH));
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.bottom = 'auto';
    return { left: left, top: top };
  }
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { saved = null; }
  if (saved && typeof saved.left === 'number') {
    applyPos(saved.left, saved.top);
  } else {
    box.style.left = '10px';
    box.style.bottom = '52px';
    box.style.top = 'auto';
  }

  var drag = null;
  box.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    var r = box.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
    box.classList.add('dragging');
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!drag) return;
    drag.moved = true;
    applyPos(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  window.addEventListener('mouseup', function () {
    if (!drag) return;
    box.classList.remove('dragging');
    if (drag.moved) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({
          left: parseInt(box.style.left, 10), top: parseInt(box.style.top, 10)
        }));
      } catch (e) {}
    } else {
      hop();
      refresh(true);
    }
    drag = null;
  });

  function hop() {
    box.classList.remove('hop');
    void box.offsetWidth;          // 强制重排，让动画能重播
    box.classList.add('hop');
    setTimeout(function () { box.classList.remove('hop'); }, 700);
  }

  /* ---------- 数据 ---------- */
  function reminder() {
    if (!stats || !stats.ok || stats.balance === null) return '余额查不到，检查一下 API 密钥～';
    var b = Number(stats.balance);
    var today = Number(stats.daySpent || 0);
    var msg = '余额 ' + money(b, stats.currency);
    msg += today > 0 ? '，今天用了 ' + money(today, stats.currency) : '，今天还没花钱～';
    if (b < 5) msg += ' 该充值啦！';
    return msg;
  }

  function paint() {
    if (stats && stats.ok) {
      vBal.textContent = money(stats.balance, stats.currency);
      vRun.textContent = money(stats.runSpent, stats.currency);
    } else {
      vBal.textContent = '—';
      vRun.textContent = '—';
    }
    var t = readTokens();
    vTok.textContent = t || '—';
    vTok.title = t ? ('DSH 统计：' + t) : '当前会话还没有用量（发起一轮对话后出现）';
    say.textContent = reminder();
  }

  async function refresh(showBubble) {
    try {
      var s = await window.dshSwitch.refreshStats();
      if (s && s.ok) stats = s;
    } catch (e) { /* 忽略 */ }
    paint();
    if (showBubble) show(2600);
  }

  var bubbleTimer = null;
  function show(ms) {
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    if (ms) bubbleTimer = setTimeout(function () { bubble.classList.remove('show'); }, ms);
  }
  box.addEventListener('mouseenter', function () { show(); });
  box.addEventListener('mouseleave', function () {
    bubble.classList.remove('show');
    clearTimeout(bubbleTimer);
  });

  function mount() {
    if (!document.body) return false;
    document.body.appendChild(box);
    paint();
    setTimeout(function () { show(7000); }, 700);    // 打开时冒个泡提醒
    return true;
  }
  mount();

  // 定时同步余额与 token（被 DSH 重绘掉的话自动补回来）
  if (!window.__dshMascotTimer) {
    window.__dshMascotTimer = setInterval(async function () {
      if (!document.getElementById(ID)) { mount(); }
      try {
        var s = await window.dshSwitch.stats();
        if (s && s.ok) stats = s;
      } catch (e) { /* 忽略 */ }
      paint();
    }, 30000);
  }

  return 'ok';
})()
