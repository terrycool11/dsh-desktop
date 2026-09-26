/* ============================================================
   DSH Desktop — Electron 主进程
   把 `dsh web` 的浏览器界面封装成独立桌面应用。

   关键点：DSH Web 有「启动令牌」保护 —— 服务每次启动会生成一个随机
   token，只打印在 stdout（`dsh web: http://127.0.0.1:3080/?token=...`），
   浏览器首次访问该地址后才会写下鉴权 Cookie。
   所以桌面端必须自己拉起服务并读取那行 URL，无法凭空接入别人的服务。

   启动策略：
     1) 复用上次由本应用启动、且进程仍在的服务（runtime.json 里的 pid + URL）
     2) 否则自己拉起 `dsh web --no-open --port <port>` 并解析 stdout 拿到令牌 URL
     3) 首选端口被别的 DSH 服务占用时，自动改用下一个空闲端口
   ============================================================ */

'use strict';

const { app, BrowserWindow, Menu, shell, dialog, ipcMain, safeStorage } = require('electron');
const { spawn, execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');

const APP_NAME = 'DSH Desktop';

/* ---------------- 配置 ---------------- */

const CONFIG_DEFAULTS = {
  host: '127.0.0.1',
  port: 3080,
  workspace: '',          // 拉起服务时的工作目录；留空 = 用户主目录
  // 关闭窗口时是否结束后台的 dsh web 服务。
  // 默认 false：DSH 经常在跑长任务，关窗口不该把它掐掉；下次启动会直接复用（秒开）。
  // 想彻底停掉服务，用菜单「文件 → 退出并结束 DSH 服务」。
  killServerOnQuit: false,
  zoom: 1
};

let cachedConfig = null;

function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function runtimePath() { return path.join(app.getPath('userData'), 'runtime.json'); }
function logPath() { return path.join(app.getPath('userData'), 'dsh-desktop.log'); }

// 读 JSON 文件：容忍记事本等编辑器留下的 UTF-8 BOM
function readJsonFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function loadConfig() {
  if (cachedConfig) return cachedConfig;
  const parsed = readJsonFile(configPath());
  cachedConfig = parsed
    ? Object.assign({}, CONFIG_DEFAULTS, parsed)
    : Object.assign({}, CONFIG_DEFAULTS);
  return cachedConfig;
}

function saveConfig(patch) {
  cachedConfig = Object.assign(loadConfig(), patch);
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cachedConfig, null, 2), 'utf8');
  } catch (e) { /* 忽略 */ }
  return cachedConfig;
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try {
    fs.mkdirSync(path.dirname(logPath()), { recursive: true });
    fs.appendFileSync(logPath(), line + '\n', 'utf8');
  } catch (e) { /* 忽略 */ }
  if (process.argv.includes('--self-test')) process.stdout.write(line + '\n');
}

function readRuntime() {
  return readJsonFile(runtimePath());
}

function writeRuntime(data) {
  try { fs.writeFileSync(runtimePath(), JSON.stringify(data, null, 2), 'utf8'); } catch (e) { /* 忽略 */ }
}

function clearRuntime() {
  try { fs.unlinkSync(runtimePath()); } catch (e) { /* 忽略 */ }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

/* ---------------- 端口与服务 ---------------- */

function serverOrigin(port) {
  return `http://${loadConfig().host}:${port}`;
}

// 端口上有任何 HTTP 响应就算被占用
function probe(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    const req = http.get(url, { timeout: timeoutMs || 1500 }, (res) => {
      res.resume();
      done({ up: true, statusCode: res.statusCode });
    });
    req.on('error', () => done({ up: false }));
    req.on('timeout', () => { req.destroy(); done({ up: false }); });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, loadConfig().host);
  });
}

async function findFreePort(start, tries) {
  for (let i = 0; i < (tries || 20); i++) {
    if (await portFree(start + i)) return start + i;
  }
  return 0;   // 交给 DSH 自己挑（--port 0）
}

function resolveDsh() {
  const appData = process.env.APPDATA || '';
  const binJs = appData && path.join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (binJs && fs.existsSync(binJs)) return { kind: 'bin', value: binJs };

  const cands = [process.env.DSH_BIN, appData && path.join(appData, 'npm', 'dsh.cmd')].filter(Boolean);
  for (const c of cands) { if (fs.existsSync(c)) return { kind: 'cmd', value: c }; }
  return null;
}

function findNode() {
  const cands = [process.env.DSH_NODE, 'D:\\nodejs\\node.exe',
    path.join(process.env.ProgramFiles || '', 'nodejs', 'node.exe')].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ } }
  return 'node.exe';
}

let serverProc = null;        // 回退方案：直接 spawn 时的子进程句柄
let serverPid = null;         // 当前服务的 pid（无论哪种方式拉起）
let startedServerThisRun = false;
let serverUrlWithToken = '';
let serverPort = 0;
const serverLog = [];

function serverLogPath(port) {
  return path.join(app.getPath('userData'), `server-${port}.log`);
}

// 用 WMI 创建进程：父进程是 WmiPrvSE，不在 Electron 的 job 对象里。
// 这样应用退出时服务不会被一起回收 —— 会话就不会因为重启应用而断。
//
// 但 WMI 直接创建 cmd.exe 会在用户会话里分配一个控制台（conhost），
// 也就是那个黑窗口。所以外面再包一层 wscript：
//   wscript(GUI 程序，不分配控制台) → cmd(隐藏窗口) → node(服务)
function startServerDetached(port) {
  const c = loadConfig();
  const dsh = resolveDsh();
  if (!dsh) return { ok: false, reason: 'no-dsh' };

  const logFile = serverLogPath(port);
  try { fs.unlinkSync(logFile); } catch (e) { /* 不存在就算了 */ }

  const cwd = c.workspace && fs.existsSync(c.workspace) ? c.workspace : os.homedir();
  const parts = dsh.kind === 'bin'
    ? [`"${findNode()}"`, `"${dsh.value}"`]
    : [`"${dsh.value}"`];

  // 启动脚本放临时目录：路径没有空格，VBS 里就不用嵌套引号
  const tmp = app.getPath('temp');
  const launcher = path.join(tmp, `dsh-launch-server-${port}.cmd`);
  fs.writeFileSync(launcher, [
    '@echo off',
    `cd /d "${cwd}"`,
    `${parts.join(' ')} web --no-open --port ${port} < NUL > "${logFile}" 2>&1`
  ].join('\r\n'), 'utf8');

  const vbs = path.join(tmp, `dsh-launch-server-${port}.vbs`);
  fs.writeFileSync(vbs, [
    "' 由 DSH Desktop 生成：以隐藏窗口方式拉起 dsh web 服务",
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run "cmd /c ${launcher}", 0, False`
  ].join('\r\n'), 'utf8');

  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const useVbs = fs.existsSync(wscript);

  const wmiTarget = useVbs
    ? `wscript.exe //nologo ${vbs}`
    : `cmd.exe /c "${launcher}"`;

  const ps = [
    '$ErrorActionPreference = "Stop"',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${wmiTarget.replace(/'/g, "''")}'; CurrentDirectory = '${cwd.replace(/'/g, "''")}' }`,
    'Write-Output $r.ProcessId'
  ].join('; ');

  try {
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`,
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 25000 }).toString().trim();
    log('detached server launcher', useVbs ? 'wscript' : 'cmd', 'pid', out);
  } catch (e) {
    log('detached launch failed', e.message);
    return { ok: false, reason: 'wmi-failed' };
  }

  serverPort = port;
  serverUrlWithToken = '';
  return { ok: true, logFile };
}

// 回退方案：直接 spawn（服务会随应用退出而结束，但至少能用）
function startServerInline(port) {
  const c = loadConfig();
  const dsh = resolveDsh();
  if (!dsh) return { ok: false, reason: 'no-dsh' };

  const args = ['web', '--no-open', '--port', String(port)];
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;

  const opts = {
    cwd: c.workspace && fs.existsSync(c.workspace) ? c.workspace : undefined,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  };

  const child = dsh.kind === 'bin'
    ? spawn(findNode(), [dsh.value, ...args], opts)
    : spawn(dsh.value, args, Object.assign({ shell: true }, opts));

  serverProc = child;
  serverPid = child.pid;
  serverPort = port;
  serverUrlWithToken = '';

  const onData = (buf) => {
    const text = buf.toString('utf8');
    serverLog.push(text);
    if (serverLog.length > 300) serverLog.shift();
    log('server>', text.trim().split('\n').join(' | '));
    const m = /dsh web:\s*(http:\/\/\S+)/.exec(text);
    if (m && !serverUrlWithToken) {
      serverUrlWithToken = m[1];
      writeRuntime({ pid: child.pid, port, url: serverUrlWithToken, startedAt: Date.now() });
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('exit', (code) => { log('server exited', String(code)); serverProc = null; });
  child.on('error', (err) => { log('server error', err.message); serverProc = null; });

  return { ok: true, child };
}

function startServer(port) {
  startedServerThisRun = true;
  const detached = startServerDetached(port);
  if (detached.ok) return detached;
  log('falling back to inline spawn');
  return startServerInline(port);
}

// 从日志里读带令牌的 URL（detached 模式下没有 stdout 管道）
function readUrlFromLog(port) {
  try {
    const text = fs.readFileSync(serverLogPath(port), 'utf8');
    const m = /dsh web:\s*(http:\/\/\S+)/.exec(text);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

// 查服务进程 pid（detached 模式下 WMI 返回的是 cmd 的 pid，真正监听的是 node）
function findServerPid(port) {
  const ps = [
    '(Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" -ErrorAction SilentlyContinue |',
    `Where-Object { $_.CommandLine -like "*bin.js*" -and $_.CommandLine -like "*--port ${port}*" -and $_.CommandLine -notlike "*runner.js*" } |`,
    'Select-Object -First 1).ProcessId'
  ].join(' ');
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps],
      { windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const pid = parseInt(out, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (e) {
    log('findServerPid failed', e.message);
    return null;
  }
}

// 结束服务前先确认这个 pid 真的是 dsh web 服务，避免 pid 复用误杀别的进程
function pidIsDshWebServer(pid) {
  if (!pid) return false;
  try {
    const out = execSync(
      `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' -ErrorAction SilentlyContinue).CommandLine"`,
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 8000 }
    ).toString();
    return /dsh/i.test(out) && /bin\.js/i.test(out) && /web/.test(out);
  } catch (e) {
    return false;
  }
}

function killServer(reason) {
  const rt = readRuntime();
  const pid = serverPid || (serverProc && serverProc.pid) || (rt && rt.pid);
  if (!pid) return;

  if (!pidIsDshWebServer(pid)) {
    log('refusing to kill pid', String(pid), '- not a dsh web server;', reason || '');
    serverProc = null;
    serverPid = null;
    clearRuntime();
    return;
  }

  log('killing dsh web server pid', String(pid), reason ? '(' + reason + ')' : '');
  try {
    execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
  } catch (e) { /* 可能已退出 */ }
  serverProc = null;
  serverPid = null;
  clearRuntime();
}

/* ---------------- DeepSeek 开放平台 ---------------- */

const DEEPSEEK_BASE = 'https://api.deepseek.com';

function platformStorePath() { return path.join(app.getPath('userData'), 'platform.json'); }

function readPlatformStore() {
  return readJsonFile(platformStorePath()) || {};
}

function writePlatformStore(data) {
  try {
    fs.mkdirSync(path.dirname(platformStorePath()), { recursive: true });
    fs.writeFileSync(platformStorePath(), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { log('platform store write failed', e.message); }
}

function secureAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch (e) { return false; }
}

// 密钥三来源：本应用保存（DPAPI 加密） > DSH 凭据 > 无
function saveApiKey(key) {
  const store = readPlatformStore();
  if (secureAvailable()) {
    store.keyCipher = safeStorage.encryptString(key).toString('base64');
    delete store.keyPlain;
  } else {
    store.keyPlain = key;
    delete store.keyCipher;
  }
  writePlatformStore(store);
}

function readSavedApiKey() {
  const store = readPlatformStore();
  if (store.keyCipher) {
    try { return safeStorage.decryptString(Buffer.from(store.keyCipher, 'base64')); }
    catch (e) { log('decrypt api key failed', e.message); return null; }
  }
  return store.keyPlain || null;
}

// DSH 自己的凭据库：~/.dsh/.credentials.yaml 里的 refs.DEEPSEEK_API_KEY
function readDshApiKey() {
  try {
    const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const text = fs.readFileSync(p, 'utf8');
    const m = /^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s]+)["']?\s*$/m.exec(text);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

function activeApiKey() {
  const saved = readSavedApiKey();
  if (saved) return { key: saved, source: 'saved' };
  const dsh = readDshApiKey();
  if (dsh) return { key: dsh, source: 'dsh' };
  return { key: null, source: 'none' };
}

function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 12) return key.slice(0, 3) + '****';
  return key.slice(0, 5) + '****' + key.slice(-4);
}

// 统一的开放平台请求：主进程直接发，绕开渲染进程的跨域限制
async function dsRequest(pathname, options, keyOverride) {
  const key = keyOverride || activeApiKey().key;
  if (!key) return { ok: false, error: '未配置 API 密钥' };

  const opts = Object.assign({}, options);
  opts.headers = Object.assign({
    Authorization: 'Bearer ' + key,
    Accept: 'application/json'
  }, opts.headers || {});
  if (opts.body && !opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';

  try {
    const res = await fetch(DEEPSEEK_BASE + pathname, opts);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || text.slice(0, 240) || ('HTTP ' + res.status);
      return { ok: false, error: `HTTP ${res.status} · ${msg}`, status: res.status };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: '网络错误：' + (e.message || String(e)) };
  }
}

const streamControllers = new Map();

async function chatStart(event, payload) {
  const key = activeApiKey().key;
  if (!key) return { ok: false, error: '未配置 API 密钥' };

  const streamId = 'ds-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const controller = new AbortController();
  streamControllers.set(streamId, controller);

  const sender = event.sender;
  const send = (p) => {
    if (sender && !sender.isDestroyed()) sender.send('platform:chat-chunk', Object.assign({ streamId }, p));
  };

  const body = {
    model: payload.model || 'deepseek-chat',
    messages: payload.messages || [],
    stream: true,
    stream_options: { include_usage: true }
  };
  if (payload.effort) body.reasoning_effort = payload.effort;
  if (Number.isFinite(payload.temperature)) body.temperature = payload.temperature;

  (async () => {
    try {
      const res = await fetch(DEEPSEEK_BASE + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) {
        const t = await res.text();
        let msg = t.slice(0, 240);
        try { const j = JSON.parse(t); msg = (j.error && j.error.message) || msg; } catch (e) { /* ignore */ }
        send({ type: 'error', message: `HTTP ${res.status} · ${msg}` });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const events = buf.split('\n\n');
        buf = events.pop();

        for (const ev of events) {
          for (const line of ev.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;
            let j;
            try { j = JSON.parse(raw); } catch (e) { continue; }

            const delta = j.choices && j.choices[0] && j.choices[0].delta;
            if (delta && (delta.content || delta.reasoning_content)) {
              send({ type: 'delta', content: delta.content || '', reasoning: delta.reasoning_content || '' });
            }
            if (j.usage) {
              send({
                type: 'usage',
                prompt_tokens: j.usage.prompt_tokens || 0,
                completion_tokens: j.usage.completion_tokens || 0,
                total_tokens: j.usage.total_tokens || 0
              });
            }
          }
        }
      }
      send({ type: 'done' });
    } catch (e) {
      if (e && e.name === 'AbortError') send({ type: 'done', aborted: true });
      else send({ type: 'error', message: (e && e.message) || String(e) });
    } finally {
      streamControllers.delete(streamId);
    }
  })();

  return { ok: true, streamId };
}

function registerPlatformIpc() {
  ipcMain.handle('platform:state', () => {
    const { key, source } = activeApiKey();
    return {
      ok: true,
      baseUrl: DEEPSEEK_BASE,
      secure: secureAvailable(),
      key: { present: !!key, masked: maskApiKey(key), source }
    };
  });

  ipcMain.handle('platform:save-key', (e, key) => {
    const k = String(key || '').trim();
    if (!k) return { ok: false, error: '密钥为空' };
    if (!/^sk-/.test(k)) return { ok: false, error: '密钥格式看起来不对（应以 sk- 开头）' };
    saveApiKey(k);
    log('api key saved (secure=' + secureAvailable() + ')');
    return { ok: true };
  });

  ipcMain.handle('platform:clear-key', () => {
    const store = readPlatformStore();
    delete store.keyCipher;
    delete store.keyPlain;
    writePlatformStore(store);
    return { ok: true };
  });

  ipcMain.handle('platform:import-key', () => {
    const k = readDshApiKey();
    if (!k) return { ok: false, error: '没能从 ~/.dsh/.credentials.yaml 读到 DEEPSEEK_API_KEY' };
    saveApiKey(k);
    return { ok: true };
  });

  ipcMain.handle('platform:test-key', async (e, typed) => {
    const res = await dsRequest('/models', { method: 'GET' }, typed || undefined);
    if (!res.ok) return res;
    return { ok: true, count: ((res.data && res.data.data) || []).length };
  });

  ipcMain.handle('platform:balance', () => dsRequest('/user/balance', { method: 'GET' }));
  ipcMain.handle('platform:models', () => dsRequest('/models', { method: 'GET' }));

  ipcMain.handle('platform:chat-start', (event, payload) => chatStart(event, payload || {}));

  ipcMain.handle('platform:chat-abort', (e, id) => {
    const c = streamControllers.get(id);
    if (!c) return { ok: false, error: '没有正在进行的请求' };
    c.abort();
    return { ok: true };
  });

  ipcMain.handle('platform:open-external', (e, url) => {
    if (/^https?:\/\//.test(String(url))) shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('platform:app-icon', () => iconDataUrl());

  // 两个视图互切（Harness 里注入的浮动按钮、开放平台顶栏按钮、菜单都走这里）
  ipcMain.handle('view:switch', (e, target) => switchView(target === 'platform' ? 'platform' : 'harness'));
  ipcMain.handle('view:current', () => {
    const platformVisible = !!(platformWindow && !platformWindow.isDestroyed() && platformWindow.isVisible());
    return { ok: true, view: platformVisible ? 'platform' : 'harness' };
  });

  // Q 版助手侧栏面板用的数据
  ipcMain.handle('stats:get', () => usageSnapshot());
  ipcMain.handle('stats:refresh', async () => { await sampleBalance(); return usageSnapshot(); });
  ipcMain.handle('mascot:data-url', () => mascotDataUrl());
}

/* ---------------- 用量跟踪（余额 / 消耗） ---------------- */

// DeepSeek 开放平台没有"用量查询"接口，只有余额接口。
// 所以消耗金额靠**采样余额的下降**推算：
//   本次消耗 = 本次运行第一次采样到的余额 - 当前余额
//   今日消耗 = 当天下滑量累加（跨次运行持久化在 usage.json）
// 注意：这统计的是整个账号，同一把密钥的其它工具用量也会算进来。
const BALANCE_POLL_MS = 60000;

let usageState = {
  day: null,
  daySpent: 0,
  last: null,
  balance: null,
  currency: 'CNY',
  updatedAt: null,
  samples: 0
};
let runStartBalance = null;   // 本次运行的起始余额（内存态）
let balanceTimer = null;
let lastBalanceError = null;

function usageStorePath() { return path.join(app.getPath('userData'), 'usage.json'); }

function loadUsage() {
  const u = readJsonFile(usageStorePath());
  if (u && typeof u === 'object') Object.assign(usageState, u);
}

function saveUsage() {
  try {
    fs.mkdirSync(path.dirname(usageStorePath()), { recursive: true });
    fs.writeFileSync(usageStorePath(), JSON.stringify(usageState, null, 2), 'utf8');
  } catch (e) { /* 忽略 */ }
}

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

async function sampleBalance() {
  const res = await dsRequest('/user/balance', { method: 'GET' });
  if (!res.ok) {
    lastBalanceError = res.error || '查询失败';
    return { ok: false, error: lastBalanceError };
  }
  const info = (res.data.balance_infos || [])[0];
  if (!info) {
    lastBalanceError = '接口未返回余额';
    return { ok: false, error: lastBalanceError };
  }

  const cur = parseFloat(info.total_balance);
  const day = todayKey();
  if (usageState.day !== day) {          // 跨天重置今日消耗
    usageState.day = day;
    usageState.daySpent = 0;
  }
  if (runStartBalance === null) runStartBalance = cur;
  if (usageState.last !== null && cur < usageState.last) {
    usageState.daySpent = Number((usageState.daySpent + (usageState.last - cur)).toFixed(6));
  }
  usageState.last = cur;
  usageState.balance = cur;
  usageState.currency = info.currency || 'CNY';
  usageState.updatedAt = Date.now();
  usageState.samples = (usageState.samples || 0) + 1;
  lastBalanceError = null;
  saveUsage();
  return { ok: true };
}

function usageSnapshot() {
  const cur = usageState.balance;
  return {
    ok: true,
    hasKey: !!activeApiKey().key,
    balance: cur,
    currency: usageState.currency,
    runSpent: (runStartBalance !== null && cur !== null)
      ? Math.max(0, Number((runStartBalance - cur).toFixed(6))) : null,
    daySpent: usageState.daySpent,
    day: usageState.day,
    updatedAt: usageState.updatedAt,
    samples: usageState.samples,
    error: lastBalanceError
  };
}

function startBalanceTracking() {
  loadUsage();
  sampleBalance().catch(() => {});
  if (balanceTimer) clearInterval(balanceTimer);
  balanceTimer = setInterval(() => { sampleBalance().catch(() => {}); }, BALANCE_POLL_MS);
}

/* ---------------- 窗口 ---------------- */

let mainWindow = null;
let splashWindow = null;
let platformWindow = null;
let launcherWindow = null;

/* ---------------- 启动页 ---------------- */

function createLauncherWindow() {
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.show();
    launcherWindow.focus();
    return launcherWindow;
  }

  launcherWindow = new BrowserWindow({
    width: 780, height: 470,
    resizable: false, maximizable: false, fullscreenable: false,
    frame: false, show: false,
    title: 'DSH Desktop',
    backgroundColor: '#06080f',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'launcher', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  launcherWindow.loadFile(path.join(__dirname, 'launcher', 'launcher.html'));
  launcherWindow.once('ready-to-show', () => { launcherWindow.show(); launcherWindow.focus(); });
  launcherWindow.on('closed', () => { launcherWindow = null; });
  launcherWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return launcherWindow;
}

function closeLauncher() {
  if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.destroy();
  launcherWindow = null;
}

function registerLauncherIpc() {
  ipcMain.handle('launcher:info', () => {
    const rt = readRuntime();
    const key = activeApiKey();
    return {
      version: app.getVersion(),
      port: loadConfig().port,
      serverUp: !!(rt && isProcessAlive(rt.pid)),
      keyPresent: !!key.key,
      keySource: key.source === 'dsh' ? 'DSH 凭据' : key.source === 'saved' ? '本应用已保存' : '未配置',
      lastChoice: loadConfig().entryChoice || 'harness'
    };
  });

  ipcMain.handle('launcher:balance', async () => {
    const res = await dsRequest('/user/balance', { method: 'GET' });
    if (!res.ok) return { ok: false };
    const info = (res.data.balance_infos || [])[0];
    if (!info) return { ok: false };
    const cur = info.currency === 'USD' ? '$' : '¥';
    return { ok: true, balance: `${cur}${info.total_balance}` };
  });

  ipcMain.handle('launcher:choose', (e, payload) => {
    const mode = payload && payload.mode === 'platform' ? 'platform' : 'harness';
    if (payload && payload.remember) {
      saveConfig({ showLauncher: false, entryChoice: mode });
    } else {
      saveConfig({ entryChoice: mode });
    }
    log('launcher choice', mode, payload && payload.remember ? '(remembered)' : '');

    // 先开目标窗口再关启动页：否则中间会有一瞬间窗口数为 0，
    // 触发 window-all-closed 把应用直接退出。
    transitioning = true;
    if (mode === 'platform') {
      openPlatformTab('overview');
    } else {
      boot(false);
    }
    closeLauncher();
    setTimeout(() => { transitioning = false; }, 2500);

    return { ok: true };
  });

  ipcMain.handle('launcher:quit', () => {
    forceKillOnQuit = false;
    app.quit();
    return { ok: true };
  });
}

/* ---------------- 启动入口选择 ---------------- */

function startEntryFlow() {
  const c = loadConfig();
  const testLauncher = process.argv.includes('--self-test-launcher');

  // 自检启动页：先把启动页显示出来，交给 runSelfTest 驱动后续流程
  if (testLauncher) {
    createLauncherWindow();
    scheduleSelfTest(2500);
    return;
  }
  if (process.argv.includes('--self-test')) {
    boot(false);   // 其余自检直接进 Harness
    return;
  }
  if (c.showLauncher === false && c.entryChoice) {
    log('auto entry', c.entryChoice);
    if (c.entryChoice === 'platform') openPlatformTab('overview');
    else boot(false);
    return;
  }
  createLauncherWindow();
}

let iconDataUrlCache = null;

function iconDataUrl() {
  if (iconDataUrlCache !== null) return iconDataUrlCache;
  try {
    const png = fs.readFileSync(path.join(__dirname, 'assets', 'icon.png'));
    iconDataUrlCache = 'data:image/png;base64,' + png.toString('base64');
  } catch (e) {
    iconDataUrlCache = '';
  }
  return iconDataUrlCache;
}

let mascotDataUrlCache = null;

// Q 版助手素材：整身立绘（chibi-full.png），旧的分层部件作为兜底
function mascotDataUrl() {
  if (mascotDataUrlCache !== null) return mascotDataUrlCache;
  const read = (f) => {
    const p = path.join(__dirname, 'assets', f);
    try {
      return fs.existsSync(p) ? 'data:image/png;base64,' + fs.readFileSync(p).toString('base64') : '';
    } catch (e) { return ''; }
  };
  mascotDataUrlCache = {
    full: read('chibi-full.png'),
    upper: read('chibi-upper.png'),
    lower: read('chibi-lower.png'),
    arm: read('chibi-arm.png')
  };
  if (!mascotDataUrlCache.full) {
    mascotDataUrlCache.full = read('mascot-chibi.png') || read('mascot.png');   // 退回旧素材
  }
  return mascotDataUrlCache;
}

// 开放平台面板：独立窗口，沙箱 + contextIsolation，只通过 preload 的 IPC 通道
function createPlatformWindow() {
  if (platformWindow && !platformWindow.isDestroyed()) return platformWindow;

  const b = loadConfig().platformBounds || { width: 1160, height: 800 };

  platformWindow = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y,
    minWidth: 900, minHeight: 620,
    title: 'DeepSeek 开放平台',
    backgroundColor: '#06080f',
    icon: appIcon(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'platform', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  platformWindow.setMenuBarVisibility(false);
  platformWindow.loadFile(path.join(__dirname, 'platform', 'platform.html'));
  platformWindow.once('ready-to-show', () => platformWindow.show());

  platformWindow.on('close', () => {
    if (!platformWindow || platformWindow.isDestroyed()) return;
    if (!platformWindow.isMaximized() && !platformWindow.isFullScreen()) {
      saveConfig({ platformBounds: platformWindow.getBounds() });
    }
    setTimeout(() => handleWindowClosed('platform'), 50);
  });
  platformWindow.on('closed', () => { log('platform window closed'); platformWindow = null; });

  platformWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  platformWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  return platformWindow;
}

function openPlatformTab(tab) {
  const w = createPlatformWindow();
  const go = () => { if (!w.isDestroyed()) w.webContents.send('platform:switch-tab', tab); };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', go);
  else go();
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
  return w;
}

function loadBounds() {
  const c = loadConfig();
  if (c.bounds && typeof c.bounds.width === 'number') return c.bounds;
  return { width: 1500, height: 950 };
}

/* ---------------- 两个视图互相切换 ---------------- */

// Harness 窗口里注入的浮动切换按钮。
// 挂在 document.body 上并用 MutationObserver 兜底：DSH 是单页应用，
// 万一它重绘了 body，按钮会被补回来。
const SWITCH_BUTTON_JS = `(function () {
  var ID = 'dsh-switch-to-platform';
  function build() {
    var b = document.createElement('button');
    b.id = ID;
    b.type = 'button';
    b.innerHTML = '<span style="font-size:13px;line-height:1">\u21C4</span><span>开放平台</span>';
    b.title = '切换到 DeepSeek 开放平台（Ctrl+Shift+P）';
    b.style.cssText = [
      'position:fixed', 'top:10px', 'right:14px', 'z-index:2147483000',
      'display:inline-flex', 'align-items:center', 'gap:6px',
      'padding:6px 12px', 'border:1px solid rgba(120,140,170,.45)', 'border-radius:999px',
      'background:rgba(24,32,48,.88)', 'color:#e8eefb', 'font-size:12.5px', 'font-weight:600',
      'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'cursor:pointer', 'box-shadow:0 6px 20px -8px rgba(0,0,0,.6)',
      'backdrop-filter:blur(8px)', 'opacity:.72'
    ].join(';');
    b.addEventListener('mouseenter', function () { b.style.opacity = '1'; });
    b.addEventListener('mouseleave', function () { b.style.opacity = '.72'; });
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      if (window.dshSwitch) window.dshSwitch.to('platform');
    });
    return b;
  }
  function ensure() {
    if (document.getElementById(ID)) return;
    if (!document.body) return;
    document.body.appendChild(build());
  }
  ensure();
  if (!window.__dshSwitchObserver) {
    window.__dshSwitchObserver = new MutationObserver(function () { ensure(); });
    window.__dshSwitchObserver.observe(document.documentElement, { childList: true, subtree: false });
  }
  return document.getElementById(ID) ? 'ok' : 'no-body';
})()`;

function injectSwitchButton() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(SWITCH_BUTTON_JS).catch(() => {});
}

// 左侧栏的 Q 版助手面板：形象 + 余额 / 消耗 / token
// token 一栏直接读 DSH 自己渲染的用量 pill（[data-composer-stats]），
// 那是 DSH 的 tokenMeter 投影算出来的，比我自己估准。
// 左侧栏的 Q 版助手：完整角色（三层素材分层动画 + 可拖动 + 提醒气泡）
// 脚本放在 harness/mascot-panel.js，避免在 main.js 里塞一大段注入代码。
function mascotPanelScript() {
  return fs.readFileSync(path.join(__dirname, 'harness', 'mascot-panel.js'), 'utf8');
}

function injectMascotPanel() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.executeJavaScript(mascotPanelScript()).catch(() => {});
}

function showWindow(w) {
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

// 切换视图：显示目标、隐藏当前（隐藏而不是销毁，切回来是瞬时的，
// 开放平台里的对话记录也不会丢）
function switchView(target, options) {
  const opts = options || {};
  if (target === 'platform') {
    const w = createPlatformWindow();
    showWindow(w);
    if (!opts.keepHarness && mainWindow && !mainWindow.isDestroyed()) {
      saveBounds();
      mainWindow.hide();
    }
    return { ok: true, view: 'platform' };
  }

  const harnessReady = mainWindow && !mainWindow.isDestroyed() &&
    /^https?:/.test(mainWindow.webContents.getURL());
  if (harnessReady) {
    showWindow(mainWindow);
  } else {
    boot(false);   // 还没起过服务就现在起（会显示启动画面）
  }
  if (platformWindow && !platformWindow.isDestroyed()) platformWindow.hide();
  log('switch view -> harness');
  return { ok: true, view: 'harness' };
}

// 关闭窗口时：如果其余窗口都只是被隐藏（或没有别的窗口），就退出应用，
// 避免出现「点了关闭却什么都没发生」
function handleWindowClosed(which) {
  const others = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible());
  if (others.length === 0) {
    log('no visible window left after closing', which, '- quitting');
    app.quit();
  }
}

function saveBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
  saveConfig({ bounds: mainWindow.getBounds() });
}

function appIcon() {
  const ico = path.join(__dirname, 'assets', 'icon.ico');
  const png = path.join(__dirname, 'assets', 'icon.png');
  if (fs.existsSync(ico)) return ico;
  if (fs.existsSync(png)) return png;
  return undefined;
}

function splashHtml(message, detail) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden;background:#06080f;color:#e9eefb;
    font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;-webkit-user-select:none;user-select:none}
  .box{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;
    background:radial-gradient(ellipse at 50% 0%,rgba(102,192,244,.18),transparent 62%)}
  .logo{width:66px;height:66px;border-radius:19px;display:grid;place-items:center;overflow:hidden;
    background:linear-gradient(115deg,#5eb3f6,#22d3ee 45%,#8b5cf6);
    box-shadow:0 18px 44px -16px rgba(102,192,244,.95)}
  .logo svg{width:36px;height:36px}
  .logo img{width:100%;height:100%;object-fit:cover;display:block}
  h1{font-size:17px;margin:0;font-weight:700}
  p{margin:0;font-size:12.6px;color:#94a3bd;text-align:center;line-height:1.75;padding:0 30px}
  .bar{width:210px;height:4px;border-radius:99px;background:rgba(255,255,255,.1);overflow:hidden;margin-top:2px}
  .bar i{display:block;width:38%;height:100%;border-radius:99px;
    background:linear-gradient(90deg,#5eb3f6,#8b5cf6);animation:run 1.15s ease-in-out infinite}
  @keyframes run{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}
  .detail{font-size:11.5px;color:#5f6b85;max-width:400px;word-break:break-all;text-align:center;line-height:1.7}
  </style></head><body><div class="box">
    <div class="logo">${iconDataUrl()
      ? `<img src="${iconDataUrl()}" alt="">`
      : '<svg viewBox="0 0 24 24" fill="none" stroke="#05131f" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l6 5-6 5M13 17h5"/></svg>'}</div>
    <h1>DSH Desktop</h1>
    <p>${message}</p>
    <div class="bar"><i></i></div>
    <div class="detail">${detail || ''}</div>
  </div></body></html>`;
}

function showSplash(message, detail) {
  const url = 'data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml(message, detail));
  if (splashWindow && !splashWindow.isDestroyed()) { splashWindow.loadURL(url); return; }
  splashWindow = new BrowserWindow({
    width: 470, height: 330, frame: false, resizable: false, show: true,
    backgroundColor: '#06080f', icon: appIcon(),
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  splashWindow.loadURL(url);
  splashWindow.on('closed', () => { splashWindow = null; });
}

function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
}

function createMainWindow() {
  const b = loadBounds();
  mainWindow = new BrowserWindow({
    width: b.width, height: b.height, x: b.x, y: b.y,
    minWidth: 1020, minHeight: 680,
    show: false, title: APP_NAME,
    backgroundColor: '#06080f', icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'harness', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    closeSplash();
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isInternal(url) && !url.startsWith('data:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('close', () => {
    saveBounds();
    setTimeout(() => handleWindowClosed('harness'), 50);
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('did-finish-load', () => {
    const z = loadConfig().zoom || 1;
    if (z !== 1) mainWindow.webContents.setZoomFactor(z);
    // DSH 页面加载完成后注入「切换到开放平台」的浮动按钮 + Q 版助手面板
    setTimeout(() => { injectSwitchButton(); injectMascotPanel(); }, 300);
  });

  return mainWindow;
}

function ensureMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  return mainWindow;
}

function isInternal(url) {
  try {
    const u = new URL(url);
    return (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === String(serverPort);
  } catch (e) { return false; }
}

function esc(s) {
  return String(s).replace(/[<>&]/g, (m) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m]));
}

function toastInfo(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(
      `(function(){try{var d=document.createElement('div');d.textContent=${JSON.stringify(message)};` +
      `d.style.cssText='position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:99999;` +
      `padding:11px 20px;border-radius:11px;background:rgba(17,23,38,.97);border:1px solid rgba(255,255,255,.18);` +
      `color:#e9eefb;font-size:13.5px;font-family:system-ui,sans-serif;box-shadow:0 20px 50px -20px #000';` +
      `document.body.appendChild(d);setTimeout(function(){d.remove()},2600);}catch(e){}})()`
    ).catch(() => {});
  }
}

function errorPage(title, lines) {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#06080f;color:#e9eefb;
    font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  .box{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
    padding:40px;text-align:center}
  h1{font-size:20px;margin:0}
  p{margin:0;color:#94a3bd;font-size:13.5px;line-height:1.85;max-width:680px}
  code{background:rgba(255,255,255,.07);padding:2px 7px;border-radius:6px;font-size:12.5px;color:#bcd6ea;
    word-break:break-all}
  pre{max-width:760px;max-height:220px;overflow:auto;text-align:left;background:rgba(255,255,255,.04);
    border:1px solid rgba(255,255,255,.09);border-radius:10px;padding:12px;font-size:11.5px;color:#8f9cb5}
  button{margin-top:12px;padding:11px 22px;border:0;border-radius:11px;cursor:pointer;font-size:14px;font-weight:600;
    color:#04131f;background:linear-gradient(115deg,#66c0f4,#8b5cf6)}
  </style></head><body><div class="box">
    <h1>${title}</h1>
    ${lines.map((l) => '<p>' + l + '</p>').join('')}
    <button onclick="location.reload()">重新加载</button>
  </div></body></html>`;
  ensureMainWindow().loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

/* ---------------- 菜单 ---------------- */

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '打开配置文件夹', click: () => shell.openPath(app.getPath('userData')) },
        { label: '打开工作区', click: () => shell.openPath(loadConfig().workspace) },
        { label: '打开日志', click: () => shell.openPath(logPath()) },
        { type: 'separator' },
        { label: '显示启动页', accelerator: 'CmdOrCtrl+Shift+L', click: () => createLauncherWindow() },
        {
          label: '重新加载启动页设置',
          click: () => { saveConfig({ showLauncher: true }); toastInfo('已恢复：下次启动会显示启动页'); }
        },
        { type: 'separator' },
        {
          label: '退出（后台服务继续运行）',
          click: () => { forceKillOnQuit = false; app.quit(); }
        },
        {
          label: '退出并结束 DSH 服务',
          click: () => { forceKillOnQuit = true; app.quit(); }
        }
      ]
    },
    {
      label: '开放平台',
      submenu: [
        { label: '⇄ 在 Harness 与开放平台之间切换', accelerator: 'CmdOrCtrl+Shift+P',
          click: () => {
            const platformVisible = !!(platformWindow && !platformWindow.isDestroyed() && platformWindow.isVisible());
            switchView(platformVisible ? 'harness' : 'platform');
          } },
        { type: 'separator' },
        { label: '概览与余额', accelerator: 'CmdOrCtrl+1', click: () => openPlatformTab('overview') },
        { label: '对话测试', accelerator: 'CmdOrCtrl+2', click: () => openPlatformTab('chat') },
        { label: 'API 密钥设置', accelerator: 'CmdOrCtrl+3', click: () => openPlatformTab('settings') },
        { type: 'separator' },
        { label: '打开开放平台控制台', click: () => shell.openExternal('https://platform.deepseek.com/') },
        { label: '打开 API 文档', click: () => shell.openExternal('https://api-docs.deepseek.com/zh-cn/') },
        { label: '查看服务状态', click: () => shell.openExternal('https://status.deepseek.com/') }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭窗口' }] },
    {
      label: '帮助',
      submenu: [
        { label: '重新连接服务', click: () => boot(true) },
        {
          label: '关于 DSH Desktop',
          click: () => dialog.showMessageBox(mainWindow, {
            type: 'info', title: '关于 DSH Desktop', message: 'DSH Desktop',
            detail: [
              'DeepSeek Harness 桌面客户端',
              '',
              `版本: ${app.getVersion()}`,
              `Electron: ${process.versions.electron}`,
              `Chromium: ${process.versions.chrome}`,
              '',
              `服务地址: ${serverOrigin(serverPort || loadConfig().port)}`,
              `工作区: ${loadConfig().workspace}`,
              `关闭窗口时结束后台服务: ${loadConfig().killServerOnQuit ? '是' : '否（下次启动秒开）'}`,
              `配置文件: ${configPath()}`,
              `日志: ${logPath()}`
            ].join('\n')
          })
        }
      ]
    }
  ]));
}

/* ---------------- 启动流程 ---------------- */

let booting = false;

async function resolveServerUrl() {
  const c = loadConfig();

  // 1) 复用上次启动、且进程仍活着的服务（服务是独立进程，重启应用后通常还活着）
  const rt = readRuntime();
  if (rt && rt.url && isProcessAlive(rt.pid)) {
    if ((await probe(rt.url, 1500)).up) {
      log('reusing previous server', rt.url, 'pid', String(rt.pid));
      serverPort = rt.port;
      serverPid = rt.pid;
      serverUrlWithToken = rt.url;
      startedServerThisRun = false;
      return { ok: true, url: rt.url, mode: 'reuse', port: rt.port };
    }
  }
  if (rt) clearRuntime();

  // 2) 选端口
  let port = c.port;
  if ((await probe(serverOrigin(port) + '/', 1200)).up) {
    log('port', String(port), 'occupied; picking a free one');
    port = await findFreePort(port + 1, 20);
    showSplash(`端口 ${c.port} 已被另一个 DSH 服务占用，正在切换到端口 ${port || '自动'}…`,
      '会话数据保存在 ~/.dsh，两个服务看到的是同一批会话。');
  }

  // 3) 拉起服务：优先用 WMI 脱离进程树（这样应用退出后服务仍在，会话不断）
  const started = startServer(port);
  if (!started.ok) return { ok: false, reason: started.reason };

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (serverUrlWithToken) {
      // 内联模式的 URL 来自 stdout；脱离模式来自日志
      if (!serverPid) serverPid = findServerPid(serverPort) || null;
      if (serverPid) writeRuntime({ pid: serverPid, port: serverPort, url: serverUrlWithToken, startedAt: Date.now() });
      return { ok: true, url: serverUrlWithToken, mode: 'started', port: serverPort };
    }
    const fromLog = readUrlFromLog(serverPort);
    if (fromLog) {
      serverUrlWithToken = fromLog;
      serverPid = findServerPid(serverPort) || null;
      if (serverPid) writeRuntime({ pid: serverPid, port: serverPort, url: fromLog, startedAt: Date.now() });
      log('detached server url', fromLog, 'pid', String(serverPid));
      return { ok: true, url: fromLog, mode: 'started-detached', port: serverPort };
    }
    if (serverProc === null && !startedServerThisRun) {
      return { ok: false, reason: 'exited', log: serverLog.join('') };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return { ok: false, reason: 'timeout', log: serverLog.join('') };
}

async function boot(force) {
  if (booting) return;
  booting = true;
  // 启动过程中可能短暂没有窗口（例如从启动页切换过来），挡住 window-all-closed
  transitioning = true;

  try {
    showSplash('正在启动 DSH 服务…', '首次启动需要加载插件，大约 10～30 秒。');

    const res = await resolveServerUrl();

    if (!res.ok) {
      closeSplash();
      if (res.reason === 'no-dsh') {
        errorPage('没有找到 dsh 命令', [
          '请先全局安装 DeepSeek Harness：<code>npm i -g @deepseek-ai/dsh</code>',
          `配置文件：<code>${configPath()}</code>`
        ]);
      } else {
        errorPage('DSH 服务启动失败', [
          res.reason === 'timeout' ? '服务在 120 秒内没有输出可用的访问地址。' : '服务进程提前退出了。',
          '可以在终端手动运行 <code>dsh web</code> 查看具体报错。',
          res.log ? '<pre>' + esc(res.log.slice(-1500)) + '</pre>' : ''
        ]);
      }
      ensureMainWindow().show();
      return;
    }

    log('loading', res.url, 'mode', res.mode, 'port', String(res.port));
    ensureMainWindow();
    await mainWindow.loadURL(res.url);
    mainWindow.show();
    startBalanceTracking();

    if (process.argv.includes('--self-test')) scheduleSelfTest();
  } catch (e) {
    closeSplash();
    errorPage('启动异常', ['<code>' + esc((e && e.message) || e) + '</code>']);
    ensureMainWindow().show();
  } finally {
    booting = false;
    setTimeout(() => { transitioning = false; }, 2000);
  }
}

/* ---------------- 自检（--self-test） ---------------- */

// 自检只跑一次：boot() 成功后会再调度一次，而自检本身也可能调用 boot()，
// 不加锁会导致每几秒重跑一轮、互相把对方的窗口销毁掉。
let selfTestScheduled = false;
function scheduleSelfTest(delay) {
  if (selfTestScheduled) return;
  selfTestScheduled = true;
  setTimeout(runSelfTest, delay === undefined ? 3000 : delay);
}

async function runSelfTest() {
  const rt = readRuntime() || {};
  const report = {
    serverOrigin: serverOrigin(serverPort),
    serverPort,
    startedServerOurselves: startedServerThisRun,
    serverPid: serverPid || (rt.pid || null),
    loadedUrl: mainWindow ? mainWindow.webContents.getURL().replace(/token=[^&]+/, 'token=***') : '',
    configPath: configPath(),
    ok: false,
    errors: []
  };

  // 打包后 __dirname 在 app.asar 里是只读的，自检截图写到临时目录
  const outDir = app.isPackaged
    ? path.join(app.getPath('temp'), 'dsh-desktop-selftest')
    : path.join(__dirname, '.preview');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { /* ignore */ }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 启动页 ----
  if (process.argv.includes('--self-test-launcher')) {
    try {
      const lw = createLauncherWindow();
      await new Promise((resolve) => {
        if (!lw.webContents.isLoading()) return resolve();
        lw.webContents.once('did-finish-load', resolve);
        setTimeout(resolve, 12000);
      });
      await sleep(1200);

      report.launcher = await lw.webContents.executeJavaScript(`(function () {
        var q = function (s) { return document.querySelector(s); };
        return {
          title: document.title,
          cards: document.querySelectorAll('.choice').length,
          harnessName: (q('#pickHarness .name') || {}).textContent,
          platformName: (q('#pickPlatform .name') || {}).textContent,
          harnessMeta: (q('#harnessMeta') || {}).innerText,
          platformMeta: (q('#platformMeta') || {}).innerText,
          logoLoaded: !!(q('#appLogo') || {}).src && (q('#appLogo').src || '').startsWith('data:image'),
          version: (q('#version') || {}).textContent
        };
      })()`);

      const limg = await lw.webContents.capturePage();
      const lpng = limg.toPNG();
      fs.writeFileSync(path.join(outDir, 'launcher.png'), lpng);
      report.launcher.screenshotBytes = lpng.length;

      // 点「开放平台」应打开面板窗口
      await lw.webContents.executeJavaScript("document.getElementById('pickPlatform').click()");
      await sleep(3000);
      report.launcherPickedPlatform = {
        platformWindowOpen: !!(platformWindow && !platformWindow.isDestroyed()),
        platformTitle: platformWindow && !platformWindow.isDestroyed()
          ? await platformWindow.webContents.executeJavaScript('document.title')
          : null
      };
      // 再进 Harness，走正常启动流程
      // （先挡住 window-all-closed：销毁平台窗口的瞬间窗口数为 0）
      transitioning = true;
      if (platformWindow && !platformWindow.isDestroyed()) platformWindow.destroy();
      await boot(false);
      await sleep(1500);
    } catch (e) {
      report.errors.push('launcher: ' + ((e && e.message) || e));
      if (!mainWindow) { await boot(false); await sleep(1500); }
    }
  }

  // ---- 两个视图互相切换 ----
  if (process.argv.includes('--self-test-switch') && mainWindow && !mainWindow.isDestroyed()) {
    try {
      report.switchTest = {};

      // 1) Harness 页面里应已注入浮动按钮
      report.switchTest.buttonInjected = await mainWindow.webContents.executeJavaScript(
        "!!document.getElementById('dsh-switch-to-platform')");

      // 1b) Q 版助手侧栏面板（hover 出气泡便于截图）
      await sleep(1500);
      report.switchTest.mascotPanel = await mainWindow.webContents.executeJavaScript(`(function () {
        var p = document.getElementById('dsh-mascot-panel');
        if (!p) return { present: false };
        p.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        var img = p.querySelector('img.upper') || p.querySelector('img');
        return {
          present: true,
          text: (p.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 140),
          imageLoaded: !!(img && img.naturalWidth > 0),
          layers: p.querySelectorAll('img').length
        };
      })()`);
      await sleep(700);
      try {
        fs.writeFileSync(path.join(outDir, 'mascot.png'),
          (await mainWindow.webContents.capturePage()).toPNG());
      } catch (e) { /* 截图失败不影响结果 */ }

      // 2) 点它 → 平台窗口可见、Harness 隐藏
      await mainWindow.webContents.executeJavaScript(
        "document.getElementById('dsh-switch-to-platform').click()");
      await sleep(2500);
      report.switchTest.afterSwitchToPlatform = {
        platformVisible: !!(platformWindow && !platformWindow.isDestroyed() && platformWindow.isVisible()),
        harnessVisible: !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())
      };
      if (platformWindow && !platformWindow.isDestroyed()) {
        const pimg = await platformWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'switch-platform.png'), pimg.toPNG());
        report.switchTest.platformHasToHarnessBtn = await platformWindow.webContents.executeJavaScript(
          "!!document.getElementById('toHarnessBtn')");
      }

      // 3) 点平台的「DeepSeek Harness」→ Harness 可见、平台隐藏
      if (platformWindow && !platformWindow.isDestroyed()) {
        await platformWindow.webContents.executeJavaScript(
          "document.getElementById('toHarnessBtn').click()");
        await sleep(2500);
        report.switchTest.afterSwitchToHarness = {
          platformVisible: !!(platformWindow && !platformWindow.isDestroyed() && platformWindow.isVisible()),
          harnessVisible: !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())
        };
        const himg = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'switch-harness.png'), himg.toPNG());
      }
    } catch (e) {
      report.errors.push('switchTest: ' + ((e && e.message) || e));
    }
  }

  try {
    report.page = await mainWindow.webContents.executeJavaScript(`(function () {
      return {
        title: document.title || '',
        readyState: document.readyState,
        elementCount: document.querySelectorAll('*').length,
        bodyText: (document.body ? document.body.innerText : '').slice(0, 200)
      };
    })()`);
    report.ok = report.page.elementCount > 100 &&
      !/authentication required/.test(report.page.bodyText);
    report.authenticated = !/authentication required/.test(report.page.bodyText);
  } catch (e) {
    report.errors.push('main executeJavaScript: ' + ((e && e.message) || e));
  }

  try {
    const img = await mainWindow.webContents.capturePage();
    const png = img.toPNG();
    fs.writeFileSync(path.join(outDir, 'app-page.png'), png);
    report.screenshotBytes = png.length;
    const s = img.getSize();
    report.screenshotSize = s.width + 'x' + s.height;
  } catch (e) {
    report.errors.push('main capturePage: ' + ((e && e.message) || e));
  }

  // ---- 开放平台面板 ----
  if (process.argv.includes('--self-test-platform')) {
    try {
      // 前面的切换测试会把面板窗口隐藏（甚至在某些序列里销毁），这里兜底重建
      let pw = (platformWindow && !platformWindow.isDestroyed()) ? platformWindow : createPlatformWindow();
      // 切换测试会把面板隐藏，隐藏窗口截图会报 UnknownVizError，这里先显示出来
      if (pw.isMinimized()) pw.restore();
      pw.show();
      await new Promise((resolve) => {
        if (!pw.webContents.isLoading()) return resolve();
        pw.webContents.once('did-finish-load', resolve);
        setTimeout(resolve, 15000);
      });
      // 等面板里的余额/模型请求跑完
      await new Promise((r) => setTimeout(r, 5000));
      if (pw.isDestroyed()) {
        pw = createPlatformWindow();
        await new Promise((r) => setTimeout(r, 4000));
      }

      report.platform = await pw.webContents.executeJavaScript(`(function () {
        var q = function (s) { return document.querySelector(s); };
        return {
          title: document.title,
          keyStatus: (q('#keyStatusText') || {}).textContent || '',
          balance: (q('#balanceBody') || {}).innerText.slice(0, 220),
          modelCards: document.querySelectorAll('#modelsBody .model').length,
          modelOptions: Array.prototype.map.call(document.querySelectorAll('#modelSelect option'), function (o) { return o.value; }),
          tabs: document.querySelectorAll('.tab').length,
          hasError: /查询失败|获取失败|未配置/.test((q('#balanceBody') || {}).innerText || '')
        };
      })()`);

      await sleep(600);
      const pimg = await pw.webContents.capturePage();
      const ppng = pimg.toPNG();
      fs.writeFileSync(path.join(outDir, 'platform.png'), ppng);
      report.platform.screenshotBytes = ppng.length;
      const ps = pimg.getSize();
      report.platform.screenshotSize = ps.width + 'x' + ps.height;

      // 顺带验证开放平台接口本身
      const bal = await dsRequest('/user/balance', { method: 'GET' });
      report.api = {
        balanceOk: bal.ok,
        balance: bal.ok ? (bal.data.balance_infos || [])[0] : null,
        error: bal.ok ? null : bal.error,
        keySource: activeApiKey().source,
        keyMasked: maskApiKey(activeApiKey().key)
      };

      // 可选：真实跑一次流式对话（会消耗少量 token）
      if (process.argv.includes('--self-test-chat')) {
        report.chat = await pw.webContents.executeJavaScript(`(async function () {
          document.querySelector('.tab[data-tab="chat"]').click();
          var input = document.getElementById('chatInput');
          input.value = '用一句话回答：1+1 等于几？';
          document.getElementById('sendBtn').click();
          var start = Date.now();
          while (Date.now() - start < 60000) {
            await new Promise(function (r) { setTimeout(r, 400); });
            var s = document.getElementById('chatStatus').textContent;
            if (s === '完成' || s === '出错' || s === '已停止') break;
          }
          var bubbles = Array.prototype.map.call(document.querySelectorAll('.msg'), function (m) {
            return {
              role: m.classList.contains('user') ? 'user' : 'assistant',
              text: (m.querySelector('.bubble') || {}).innerText.slice(0, 160)
            };
          });
          return {
            status: document.getElementById('chatStatus').textContent,
            bubbles: bubbles,
            usage: document.getElementById('usageText').textContent,
            hasThinkBlock: !!document.querySelector('.think')
          };
        })()`);
        const cimg = await pw.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'platform-chat.png'), cimg.toPNG());
      }
    } catch (e) {
      report.errors.push('platform: ' + ((e && e.stack) || (e && e.message) || e));
    }
  }

  process.stdout.write('SELFTEST::' + JSON.stringify(report) + '\n');
  const clean = report.ok && report.errors.length === 0;
  // 自检结束时收拾干净：只结束本次自己拉起的服务，复用的服务不动
  if (startedServerThisRun) killServer('self-test');
  setTimeout(() => app.exit(clean ? 0 : 1), 300);
}

/* ---------------- 生命周期 ---------------- */

// 由菜单「退出并结束 DSH 服务」置位，覆盖配置里的 killServerOnQuit
let forceKillOnQuit = false;
// 入口切换（启动页 → 目标窗口）期间，允许出现短暂的「窗口数为 0」
let transitioning = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.setAppUserModelId('com.dsh.desktop');
  app.setName(APP_NAME);

  app.whenReady().then(() => {
    registerPlatformIpc();
    registerLauncherIpc();
    buildMenu();
    startEntryFlow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) startEntryFlow();
    });
  });

  app.on('window-all-closed', () => {
    if (transitioning) return;   // 正在切换入口，别退出
    app.quit();
  });

  app.on('before-quit', () => {
    saveBounds();
    const rt = readRuntime();
    if (forceKillOnQuit || loadConfig().killServerOnQuit) {
      killServer('quit');
    } else if (rt && isProcessAlive(rt.pid)) {
      // 服务是独立进程（不是本应用的子进程），应用退出后它会继续跑，
      // 所以重启应用时能直接复用，会话不会断。
      log('keeping dsh web server alive pid', String(rt.pid), 'port', String(rt.port));
    }
  });
}
