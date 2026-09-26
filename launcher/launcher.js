/* ============================================================
   启动页逻辑：选择入口 + 显示服务/密钥状态
   ============================================================ */

'use strict';

const api = window.dshLauncher;
const $ = (s) => document.querySelector(s);

let INFO = {};

function pick(mode) {
  api.choose(mode, $('#remember').checked);
}

function bind() {
  $('#pickHarness').addEventListener('click', () => pick('harness'));
  $('#pickPlatform').addEventListener('click', () => pick('platform'));
  $('#quitBtn').addEventListener('click', () => api.quit());
  $('#closeBtn').addEventListener('click', () => api.quit());

  document.addEventListener('keydown', (e) => {
    if (e.key === '1') pick('harness');
    else if (e.key === '2') pick('platform');
    else if (e.key === 'Escape') api.quit();
    else if (e.key === 'Enter') pick(INFO.lastChoice === 'platform' ? 'platform' : 'harness');
  });
}

function render() {
  const h = $('#harnessMeta');
  if (INFO.serverUp) {
    h.innerHTML = `后台服务<b>运行中</b> · 端口 ${INFO.port} · 秒开`;
  } else {
    h.innerHTML = `后台服务未运行 · 进入时自动启动（约 10～30 秒）`;
    h.classList.add('warn');
  }

  const p = $('#platformMeta');
  if (INFO.keyPresent) {
    p.innerHTML = `API 密钥<b>已就绪</b> · ${INFO.keySource} · 余额 ${INFO.balance || '—'}`;
  } else {
    p.innerHTML = '还没配置 API 密钥，进入后可导入或填写';
    p.classList.add('warn');
  }

  $('#version').textContent = 'v' + (INFO.version || '');
}

async function init() {
  bind();
  try {
    INFO = await api.info();
  } catch (e) {
    INFO = {};
  }

  try {
    const icon = await api.appIcon();
    if (icon) $('#appLogo').src = icon;
  } catch (e) { /* ignore */ }

  render();

  // 余额是异步查的，回来了再刷新一次文案
  api.balance().then((res) => {
    if (res && res.ok && res.balance) {
      INFO.balance = res.balance;
      render();
    }
  }).catch(() => {});
}

init();
