// 校验已打包 app.asar 里的内容是否为新版本
// 用法: node tools/verify-package.js
const path = require('path');
const fs = require('fs');
const asar = require('@electron/asar');

const root = path.join(__dirname, '..');
const target = process.argv[2] || path.join(root, 'dist', 'DSH Desktop-win32-x64', 'resources', 'app.asar');

if (!fs.existsSync(target)) {
  console.error('找不到 asar: ' + target);
  process.exit(1);
}

const files = asar.listPackage(target).map((f) => f.replace(/\\/g, '/'));
console.log('asar: ' + target);
console.log('条目数: ' + files.length);

const src = asar.extractFile(target, 'main.js').toString('utf8');

const checks = {};

// --- 主进程能力 ---
checks['保留后台服务逻辑'] = src.includes('keeping dsh web server alive');
checks['pid 安全校验'] = src.includes('pidIsDshWebServer');
checks['默认不结束服务'] = /killServerOnQuit:\s*false/.test(src);
checks['菜单-退出并结束服务'] = src.includes('退出并结束 DSH 服务');
checks['自检结束后清理'] = src.includes("killServer('self-test')");
checks['端口自适配'] = src.includes('findFreePort');

// --- 开放平台 ---
checks['开放平台 IPC'] = src.includes("ipcMain.handle('platform:state'");
checks['开放平台窗口'] = src.includes('createPlatformWindow');
checks['余额接口'] = src.includes("'/user/balance'");
checks['模型接口'] = src.includes("'/models'");
checks['对话接口'] = src.includes("'/chat/completions'");
checks['DSH 凭据读取'] = src.includes('DEEPSEEK_API_KEY');
checks['DPAPI 加密'] = src.includes('safeStorage.encryptString');
checks['菜单-开放平台'] = src.includes("label: '开放平台'");

// --- 面板资源 ---
checks['panel: platform.html'] = files.includes('/platform/platform.html');
checks['panel: platform.js'] = files.includes('/platform/platform.js');
checks['panel: platform.css'] = files.includes('/platform/platform.css');
checks['panel: preload.js'] = files.includes('/platform/preload.js');

// --- 图标 ---
for (const f of ['/assets/icon.ico', '/assets/icon.png', '/assets/icon-32.png']) {
  checks['icon: ' + f.replace('/assets/', '')] = files.includes(f);
}
checks['不含图标素材(已裁剪)'] = !files.some((f) => f.startsWith('/assets/generated') || /icon-source\./.test(f));

let allOk = true;
console.log('');
for (const [k, v] of Object.entries(checks)) {
  console.log('  ' + (v ? '\u2713' : '\u2717') + ' ' + k);
  if (!v) allOk = false;
}

// ICO 尺寸
try {
  const ico = asar.extractFile(target, 'assets/icon.ico');
  const count = ico.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    sizes.push((ico[o] || 256) + 'x' + (ico[o + 1] || 256));
  }
  console.log('\n  icon.ico: ' + sizes.length + ' 个尺寸 [' + sizes.join(', ') + ']  ' + (ico.length / 1024).toFixed(1) + ' KB');
  if (sizes.length < 5) { allOk = false; console.log('  \u2717 多尺寸图标缺失'); }
} catch (e) {
  allOk = false;
  console.log('  \u2717 读取 icon.ico 失败: ' + e.message);
}

console.log('\n' + (allOk ? '打包内容校验通过' : '打包内容校验失败'));
process.exitCode = allOk ? 0 : 1;
