// 用 GitHub REST API 发布本仓库（本机没有 git/gh）
//   - 读环境变量 GH_PUBLISH_TOKEN（由 PowerShell 从凭据管理器取出，不落盘、不打印）
//   - 建仓库 → 上传所有文件（一次提交）→ 设置简介与 topics
//
// 用法: node tools/publish-github.js [owner/repo]

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const TOKEN = process.env.GH_PUBLISH_TOKEN;
const REPO = process.argv[2] || 'terrycool11/dsh-desktop';
const [OWNER, NAME] = REPO.split('/');

const DESCRIPTION = '把 DeepSeek Harness 的 dsh web 界面封装成独立桌面应用（Electron）：启动页选入口、Q 版助手提醒余额与用量、开放平台面板、视图互切、后台服务独立于应用';
const TOPICS = ['electron', 'deepseek', 'deepseek-harness', 'desktop-app', 'q-version', 'windows', 'nodejs'];

// 排除规则（对应 .gitignore）
const EXCLUDE_DIRS = new Set(['dist', 'dist-new', 'dist-old', 'dist-build', 'node_modules', '.preview', '.git', 'generated']);
const EXCLUDE_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'probe.html', 'selftest.html', 'panel-preview.png']);

// 真人录音只在本地，不进公开仓库（这是个人声音，公开不可逆）。
// 程序运行时会读这个目录；仓库里没有它，桌宠只是不出声，功能不受影响。
const EXCLUDE_PREFIXES = ['assets/voice/'];

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      if (EXCLUDE_PREFIXES.some((p) => (rel + '/').startsWith(p))) continue;
      walk(full, rel, out);
    } else {
      if (EXCLUDE_FILES.has(e.name)) continue;
      if (EXCLUDE_PREFIXES.some((p) => rel.startsWith(p))) continue;
      if (/\.(log|out|err)$/i.test(e.name)) continue;
      if (/^launch-server-/.test(e.name)) continue;
      out.push({ rel, full });
    }
  }
  return out;
}

// 带退避的请求：国内访问 api.github.com 会间歇性 TLS 断开/超时/400，
// 而一次发布要发几十个请求（还有 200KB+ 的大文件），不重试基本推不完。
const RETRY_MAX = 10;

function api(method, apiPath, body, attempt) {
  const n = attempt || 1;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers: Object.assign({
        Authorization: 'Bearer ' + TOKEN,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'dsh-desktop-publish',
        'X-GitHub-Api-Version': '2022-11-28'
      }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        // 5xx / 429 是服务端抖动；400 "malformed request" 是网络把请求体弄坏了，也要重试
        const transient = res.statusCode >= 500 || res.statusCode === 429 ||
          (res.statusCode === 400 && /malformed request/i.test(raw));
        if (transient) return retry(new Error('HTTP ' + res.statusCode));
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    function retry(err) {
      if (n >= RETRY_MAX) return reject(err);
      const wait = Math.round(700 * Math.pow(1.8, n - 1) + Math.random() * 400);
      process.stdout.write('~');   // 屏幕上打个点，表示在重试
      setTimeout(() => api(method, apiPath, body, n + 1).then(resolve, reject), wait);
    }
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
    req.on('error', retry);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // --dry：只列出会上传哪些文件，不碰网络
  if (process.argv.includes('--dry')) {
    const files = walk(ROOT, '', []);
    const total = files.reduce((s, f) => s + fs.statSync(f.full).size, 0);
    console.log('待上传 ' + files.length + ' 个文件，共 ' + (total / 1024 / 1024).toFixed(2) + ' MB：');
    files.forEach((f) => console.log('  ' + String(Math.round(fs.statSync(f.full).size / 1024)).padStart(7) + ' KB  ' + f.rel));
    return;
  }
  if (!TOKEN) { console.error('缺少 GH_PUBLISH_TOKEN'); process.exit(1); }

  // 1) 建仓库（已存在则复用）
  let r = await api('POST', '/user/repos', {
    name: NAME,
    description: DESCRIPTION,
    private: false,
    has_issues: true,
    has_wiki: false,
    auto_init: false
  });
  if (r.status === 201) {
    console.log('✓ 仓库已创建: ' + r.body.full_name);
  } else if (r.status === 422) {
    console.log('· 仓库已存在，继续推送内容');
  } else {
    console.error('建仓库失败 HTTP ' + r.status + ': ' + JSON.stringify(r.body).slice(0, 300));
    process.exit(1);
  }

  // 2) 确保仓库已初始化：空仓库(fresh)无法创建 blob，会返回 409
  let info = await api('GET', `/repos/${OWNER}/${NAME}`);
  if (info.status !== 200) { console.error('读取仓库失败 HTTP ' + info.status); process.exit(1); }
  if (!info.body.size) {
    console.log('· 空仓库，先写入占位文件产生首个提交');
    const init = await api('PUT', `/repos/${OWNER}/${NAME}/contents/.gitkeep`, {
      message: 'chore: init repository',
      content: Buffer.from('').toString('base64')
    });
    if (init.status !== 201 && init.status !== 200) {
      console.error('初始化失败 HTTP ' + init.status + ': ' + JSON.stringify(init.body).slice(0, 200));
      process.exit(1);
    }
    info = await api('GET', `/repos/${OWNER}/${NAME}`);
  }
  const branch = info.body.default_branch || 'main';
  const refRes = await api('GET', `/repos/${OWNER}/${NAME}/git/ref/heads/${branch}`);
  const parentSha = refRes.status === 200 ? refRes.body.object.sha : null;
  console.log('· 默认分支 ' + branch + '，父提交 ' + (parentSha ? parentSha.slice(0, 7) : '（无）'));

  // 3) 收集文件
  const files = walk(ROOT, '', []);
  console.log('· 待上传 ' + files.length + ' 个文件，共 ' +
    (files.reduce((s, f) => s + fs.statSync(f.full).size, 0) / 1024 / 1024).toFixed(2) + ' MB');

  // 4) 逐个建 blob（带断点续传：上传成功的 blob SHA 缓存到本地，
  //    网络抖动导致中断时，重跑会跳过已成功的文件，进度能累积）
  const cacheFile = path.join(ROOT, '.preview', 'publish-cache-' + NAME + '.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) { cache = {}; }
  const saveCache = () => {
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(cache), 'utf8');
    } catch (e) { /* 缓存写不了就退化成每次全传 */ }
  };

  const crypto = require('crypto');
  const tree = [];
  let reused = 0;
  for (const f of files) {
    const buf = fs.readFileSync(f.full);
    const key = f.rel + ':' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    if (cache[key]) {
      tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: cache[key] });
      reused++;
      process.stdout.write('=');
      continue;
    }
    const b = await api('POST', `/repos/${OWNER}/${NAME}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' });
    if (b.status !== 201) {
      saveCache();
      console.error('\n  上传失败 ' + f.rel + ' HTTP ' + b.status + ' ' + JSON.stringify(b.body).slice(0, 160));
      console.error('  （已成功的 ' + reused + '/' + files.length + ' 个记在缓存里，直接重跑本脚本即可续传）');
      process.exit(1);
    }
    cache[key] = b.body.sha;
    saveCache();
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: b.body.sha });
    process.stdout.write('.');
  }
  console.log(' 完成（本次新传 ' + (files.length - reused) + '，复用缓存 ' + reused + '）');

  // 5) tree → commit → ref
  const t = await api('POST', `/repos/${OWNER}/${NAME}/git/trees`, { tree });
  if (t.status !== 201) {
    // 缓存的 blob 可能已被 GitHub 回收（未引用会过期）——清掉缓存让下次全量重传
    console.error('建 tree 失败: ' + JSON.stringify(t.body).slice(0, 300));
    try { fs.unlinkSync(cacheFile); console.error('  已清掉 blob 缓存，请重跑（会全量重传）'); } catch (e) { /* 忽略 */ }
    process.exit(1);
  }
  try { fs.unlinkSync(cacheFile); } catch (e) { /* 提交成功，缓存没用了 */ }

  const initialMessage = [
    'Initial commit: DSH Desktop v1.4.1',
    '',
    '把 DeepSeek Harness 的 dsh web 界面封装成独立桌面应用：',
    '- 启动页：选择进入 Harness 或 DeepSeek 开放平台',
    '- Q 版助手：侧栏全身角色，漂浮/呼吸/摇摆动画，可拖动，气泡提醒余额、消耗与 token',
    '- 开放平台面板：余额、模型列表、流式对话测试、密钥管理',
    '- 视图互切：Harness ⇄ 开放平台（按钮 / 菜单 / Ctrl+Shift+P）',
    '- 后台服务用 WMI + wscript 拉起，独立于应用进程树，重启应用不断会话、不弹黑窗'
  ].join('\n');
  const commitMessage = parentSha ? (process.env.PUBLISH_MSG || 'chore: 同步仓库内容') : initialMessage;

  const c = await api('POST', `/repos/${OWNER}/${NAME}/git/commits`, {
    message: commitMessage, tree: t.body.sha, parents: parentSha ? [parentSha] : []
  });
  if (c.status !== 201) { console.error('建 commit 失败: ' + JSON.stringify(c.body).slice(0, 300)); process.exit(1); }

  const up = await api('PATCH', `/repos/${OWNER}/${NAME}/git/refs/heads/${branch}`, { sha: c.body.sha, force: true });
  if (up.status === 200) console.log('✓ 已提交到 ' + branch + ' 分支');
  else console.error('更新分支失败 HTTP ' + up.status + ': ' + JSON.stringify(up.body).slice(0, 200));

  // 6) topics
  const tp = await api('PUT', `/repos/${OWNER}/${NAME}/topics`, { names: TOPICS });
  console.log(tp.status === 200 ? '✓ topics 已设置' : '· topics 设置返回 ' + tp.status);

  console.log('\n仓库地址: https://github.com/' + OWNER + '/' + NAME);
})().catch((e) => { console.error('异常: ' + e.message); process.exit(1); });
