/* ============================================================
   Q 版助手：接进 DSH 页面左侧栏
   —— 本体是独立维护的桌宠库 harness/pet.js（来自 dsh-desktop-pet 项目），
      这里只做「应用侧粘合」：拿桥 → 取形象 → 建桌宠 → 被清掉就补回来。
      main.js 把 pet.js 与本文件拼起来一起注入。
   ============================================================ */

(async function () {
  var ID = 'dsh-pet-root';

  // 重复注入：先把上一只收掉，避免叠加
  if (window.__dshPet && window.__dshPet.destroy) {
    try { window.__dshPet.destroy(); } catch (e) { /* 忽略 */ }
    window.__dshPet = null;
  }
  var old = document.getElementById(ID);
  if (old && old.parentNode) old.parentNode.removeChild(old);

  if (typeof DshPet === 'undefined') return 'no-lib';
  if (!document.body) return 'no-body';
  if (!window.dshSwitch) return 'no-bridge';

  var parts = null;
  try { parts = await window.dshSwitch.mascot(); } catch (e) { parts = null; }
  if (!parts || !parts.full) return 'no-mascot';

  var wrap = document.createElement('div');
  wrap.id = ID;
  document.body.appendChild(wrap);

  var pet = DshPet.create({
    asset: parts.full,
    mount: wrap,
    width: 140,                       // 素材 300×431，显示一半大
    left: 10,
    bottom: 52,
    brand: '',
    tip: '拖动我可以换位置',
    provider: function () { return window.dshSwitch.stats(); },
    refreshMs: 30000
  });
  window.__dshPet = pet;

  // 给 main.js 的两个钩子：
  //   __dshPetSay —— 只把台词显示进气泡
  //   __dshPetFarewell —— 退出前告别（显示，并返回说了哪句）
  window.__dshPetSay = function (text) {
    try { pet.setLine(text, 0); pet.show(); return true; } catch (e) { return false; }
  };
  window.__dshPetFarewell = function (text) {
    try { return pet.farewell(text); } catch (e) { return ''; }
  };

  // 点一下：让主进程立刻重新采样一次余额，再刷新气泡（比等轮询快）
  wrap.addEventListener('click', function () {
    if (!window.dshSwitch || !window.dshSwitch.refreshStats) return;
    window.dshSwitch.refreshStats().then(function () {
      if (pet && pet.refresh) pet.refresh(false);
    }).catch(function () { /* 采样失败，保留旧数据 */ });
  });

  return 'ok';
})();
