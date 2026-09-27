/* ============================================================
   DSH 桌宠 · 核心库
   —— 注入任意页面即可出现一只会漂浮/呼吸/摇摆、能拖动、会冒泡提醒的 Q 版桌宠
   零依赖，UMD，可配合 Electron 桥接或油猴脚本使用。
   ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DshPet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STYLE_ID = 'dsh-pet-style';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = [
      '@keyframes dshPetFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}',
      '@keyframes dshPetBreathe{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.014)}}',
      '@keyframes dshPetSway{0%,100%{transform:rotate(-1.1deg)}50%{transform:rotate(1.1deg)}}',
      '@keyframes dshPetShadow{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(.84);opacity:.5}}',
      '@keyframes dshPetHop{0%{transform:translateY(0)}35%{transform:translateY(-14px) scale(1.03)}70%,100%{transform:translateY(0)}}',
      '@keyframes dshPetPop{from{opacity:0;transform:translateY(6px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}',

      '.dsh-pet{position:fixed;z-index:2147482900;user-select:none;cursor:grab;',
      '  font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
      '.dsh-pet.dragging{cursor:grabbing}',
      '.dsh-pet__float{animation:dshPetFloat 3.6s ease-in-out infinite;',
      '  filter:drop-shadow(0 10px 16px rgba(40,60,120,.24))}',
      '.dsh-pet.hop .dsh-pet__float{animation:dshPetHop .62s ease-out}',
      '.dsh-pet__sway{animation:dshPetSway 5.2s ease-in-out infinite;transform-origin:50% 100%}',
      '.dsh-pet__img{display:block;animation:dshPetBreathe 3.6s ease-in-out infinite;transform-origin:50% 100%}',
      '.dsh-pet__shadow{height:11px;margin:-4px auto 0;border-radius:50%;',
      '  background:radial-gradient(closest-side,rgba(40,60,120,.34),rgba(40,60,120,0));',
      '  animation:dshPetShadow 3.6s ease-in-out infinite}',

      '.dsh-pet__bubble{position:absolute;left:2px;bottom:calc(100% + 6px);width:200px;',
      '  background:var(--dsh-pet-bubble-bg,#fff);color:var(--dsh-pet-bubble-fg,#5b6478);',
      '  border:1px solid var(--dsh-pet-bubble-line,#e3e8f2);border-radius:13px;padding:8px 10px;',
      '  box-shadow:0 12px 28px -14px rgba(31,41,55,.35);font-size:11.5px;line-height:1.6;',
      '  transition:opacity .3s ease,transform .3s ease;opacity:0;transform:translateY(5px);pointer-events:none}',
      '.dsh-pet__bubble.show{opacity:1;transform:translateY(0)}',
      '.dsh-pet__say{color:var(--dsh-pet-say-fg,#1f2937);margin-bottom:4px}',
      '.dsh-pet__row{display:flex;justify-content:space-between;gap:8px}',
      '.dsh-pet__row b{font-weight:600;font-variant-numeric:tabular-nums}',
      '.dsh-pet__tip{text-align:center;font-size:10px;color:#9aa4b8;opacity:0;transition:opacity .3s}',
      '.dsh-pet:hover .dsh-pet__tip{opacity:1}',

      '.dsh-pet__brand{position:absolute;left:0;right:0;bottom:-16px;text-align:center;',
      '  font-size:9.5px;letter-spacing:.06em;color:#aab3c6;opacity:.75;pointer-events:none}'
    ].join('\n');
    (document.head || document.documentElement).appendChild(el);
  }

  var DEFAULTS = {
    asset: '',                      // 形象图片地址（URL 或 data URL）
    width: 140,
    ratio: 431 / 300,               // 素材高宽比（默认是 300×431 的立绘）
    left: 10,
    bottom: 52,
    storageKey: 'dsh-pet-pos',
    draggable: true,
    tip: '拖动我可以换位置',
    brand: '',
    bubbleWidth: 200,
    mount: null,                    // 挂载容器，默认 document.body
    autoBubbleMs: 7000,             // 打开后自动冒泡时长
    refreshMs: 30000,               // 定时刷新数据的间隔
    provider: null,                 // async () => ({ ok, balance, currency, runSpent, daySpent })
    tokensSelector: '[data-composer-stats]',   // 从页面读取 token 用量的选择器
    labels: { balance: '余额', run: '本次消耗', tokens: 'Tokens' },
    colors: { balance: '#4a6cf7', run: '#e0632f', tokens: '#2f8f6b' },
    lowBalance: 5,
    currencySymbols: { CNY: '¥', USD: '$' },
    onReady: null
  };

  function merge(a, b) {
    var out = {};
    for (var k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
    for (var j in b) if (b && Object.prototype.hasOwnProperty.call(b, j)) out[j] = b[j];
    return out;
  }

  /**
   * 创建一只桌宠
   * @param {object} options 见 DEFAULTS
   * @returns {{el:HTMLElement, refresh:Function, say:Function, show:Function, hop:Function, destroy:Function}}
   */
  function create(options) {
    var o = merge(DEFAULTS, options || {});
    injectStyle();

    var W = o.width;
    var H = Math.round(W * o.ratio);
    var boxH = H + 16;
    var stats = null;
    var destroyed = false;
    var timers = [];

    function money(v, cur) {
      if (v === null || v === undefined || isNaN(Number(v))) return '—';
      var sym = o.currencySymbols[cur] || o.currencySymbols.CNY;
      return sym + Number(v).toFixed(2);
    }

    function readTokens() {
      if (!o.tokensSelector) return '';
      var el = document.querySelector(o.tokensSelector);
      return el ? (el.innerText || '').replace(/\s+/g, ' ').trim() : '';
    }

    /* ---------- DOM ---------- */
    var box = document.createElement('div');
    box.className = 'dsh-pet';
    box.style.width = W + 'px';

    var bubble = document.createElement('div');
    bubble.className = 'dsh-pet__bubble';
    bubble.style.width = o.bubbleWidth + 'px';
    var sayEl = document.createElement('div');
    sayEl.className = 'dsh-pet__say';
    bubble.appendChild(sayEl);
    var values = {};
    ['balance', 'run', 'tokens'].forEach(function (k) {
      var row = document.createElement('div');
      row.className = 'dsh-pet__row';
      var l = document.createElement('span');
      l.textContent = o.labels[k];
      var v = document.createElement('b');
      v.textContent = '—';
      v.style.color = o.colors[k];
      row.appendChild(l); row.appendChild(v);
      bubble.appendChild(row);
      values[k] = v;
    });
    box.appendChild(bubble);

    var float = document.createElement('div');
    float.className = 'dsh-pet__float';
    var sway = document.createElement('div');
    sway.className = 'dsh-pet__sway';
    var img = document.createElement('img');
    img.className = 'dsh-pet__img';
    img.style.width = W + 'px';
    img.style.height = H + 'px';
    img.alt = '桌宠';
    if (o.asset) img.src = o.asset;
    sway.appendChild(img);
    float.appendChild(sway);
    box.appendChild(float);

    var shadow = document.createElement('div');
    shadow.className = 'dsh-pet__shadow';
    shadow.style.width = Math.round(W * 0.56) + 'px';
    box.appendChild(shadow);

    if (o.tip) {
      var tip = document.createElement('div');
      tip.className = 'dsh-pet__tip';
      tip.textContent = o.tip;
      box.appendChild(tip);
    }
    if (o.brand) {
      var brand = document.createElement('div');
      brand.className = 'dsh-pet__brand';
      brand.textContent = o.brand;
      box.appendChild(brand);
    }

    /* ---------- 位置 ---------- */
    function clampToViewport(left, top) {
      left = Math.max(0, Math.min(left, window.innerWidth - W));
      top = Math.max(0, Math.min(top, window.innerHeight - boxH));
      return { left: left, top: top };
    }
    function applyPos(left, top) {
      var p = clampToViewport(left, top);
      box.style.left = p.left + 'px';
      box.style.top = p.top + 'px';
      box.style.bottom = 'auto';
      return p;
    }
    function restorePos() {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(o.storageKey) || 'null'); } catch (e) { saved = null; }
      if (saved && typeof saved.left === 'number') {
        applyPos(saved.left, saved.top);
      } else {
        box.style.left = o.left + 'px';
        box.style.bottom = o.bottom + 'px';
        box.style.top = 'auto';
      }
    }
    function savePos() {
      try {
        localStorage.setItem(o.storageKey, JSON.stringify({
          left: parseInt(box.style.left, 10) || 0,
          top: parseInt(box.style.top, 10) || 0
        }));
      } catch (e) { /* 无痕模式等，忽略 */ }
    }

    /* ---------- 交互 ---------- */
    var drag = null;
    function onDown(e) {
      if (!o.draggable || e.button !== 0) return;
      var r = box.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false };
      box.classList.add('dragging');
      e.preventDefault();
    }
    function onMove(e) {
      if (!drag) return;
      drag.moved = true;
      applyPos(e.clientX - drag.dx, e.clientY - drag.dy);
    }
    function onUp() {
      if (!drag) return;
      box.classList.remove('dragging');
      if (drag.moved) savePos();
      else { hop(); refresh(true); }
      drag = null;
    }
    box.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    function hop() {
      box.classList.remove('hop');
      void box.offsetWidth;          // 强制重排，让动画重播
      box.classList.add('hop');
      setTimeout(function () { box.classList.remove('hop'); }, 700);
    }

    var bubbleTimer = null;
    function show(ms) {
      bubble.classList.add('show');
      clearTimeout(bubbleTimer);
      if (ms) bubbleTimer = setTimeout(function () { bubble.classList.remove('show'); }, ms);
    }
    function hide() {
      bubble.classList.remove('show');
      clearTimeout(bubbleTimer);
    }
    function say(text, ms) {
      sayEl.textContent = text;
      show(ms || 4000);
    }
    box.addEventListener('mouseenter', function () { show(); });
    box.addEventListener('mouseleave', hide);

    /* ---------- 数据 ---------- */
    function reminder() {
      if (!stats || !stats.ok || stats.balance === null || stats.balance === undefined) {
        return o.provider ? '余额查不到，检查一下数据源～' : '你好呀，我是桌宠～';
      }
      var b = Number(stats.balance);
      var today = Number(stats.daySpent || 0);
      var msg = '余额 ' + money(b, stats.currency);
      msg += today > 0 ? '，今天用了 ' + money(today, stats.currency) : '，今天还没花钱～';
      if (b < o.lowBalance) msg += ' 该充值啦！';
      return msg;
    }

    function paint() {
      values.balance.textContent = (stats && stats.ok) ? money(stats.balance, stats.currency) : '—';
      values.run.textContent = (stats && stats.ok) ? money(stats.runSpent, stats.currency) : '—';
      var t = readTokens();
      values.tokens.textContent = t || '—';
      values.tokens.title = t ? ('页面统计：' + t) : '暂无量数据';
      sayEl.textContent = reminder();
    }

    function refresh(withBubble) {
      if (destroyed) return Promise.resolve(null);
      var p = (typeof o.provider === 'function')
        ? Promise.resolve().then(o.provider)
        : Promise.resolve(null);
      return p.then(function (s) {
        if (s && s.ok !== false) stats = s;
        paint();
        if (withBubble) show(2600);
        return stats;
      }).catch(function () { paint(); return stats; });
    }

    /* ---------- 挂载 ---------- */
    var host = o.mount || document.body;
    host.appendChild(box);
    restorePos();
    paint();
    if (o.autoBubbleMs) timers.push(setTimeout(function () { show(o.autoBubbleMs); }, 700));
    if (o.provider && o.refreshMs) timers.push(setInterval(function () { refresh(false); }, o.refreshMs));
    refresh(false);

    // 视口变化时把桌宠拉回可见范围
    function onResize() {
      if (box.style.top && box.style.top !== 'auto') {
        applyPos(parseInt(box.style.left, 10) || 0, parseInt(box.style.top, 10) || 0);
      }
    }
    window.addEventListener('resize', onResize);

    var api = {
      el: box,
      refresh: refresh,
      say: say,
      show: show,
      hide: hide,
      hop: hop,
      stats: function () { return stats; },
      destroy: function () {
        destroyed = true;
        timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
        box.removeEventListener('mousedown', onDown);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('resize', onResize);
        if (box.parentNode) box.parentNode.removeChild(box);
      }
    };
    if (o.onReady) o.onReady(api);
    return api;
  }

  return { create: create, DEFAULTS: DEFAULTS, version: '1.0.0' };
});
