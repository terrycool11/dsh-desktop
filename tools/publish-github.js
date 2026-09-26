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

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) continue;
      walk(full, rel, out);
    } else {
      if (EXCLUDE_FILES.has(e.name)) continue;
      if (/\.(log|out|err)$/i.test(e.name)) continue;
      if (/^launch-server-/.test(e.name)) continue;
      out.push({ rel, full });
    }
  }
  return out;
}

function api(method, apiPath, body) {
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
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
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

  // 4) 逐个建 blob
  const tree = [];
  for (const f of files) {
    const content = fs.readFileSync(f.full).toString('base64');
    const b = await api('POST', `/repos/${OWNER}/${NAME}/git/blobs`, { content, encoding: 'base64' });
    if (b.status !== 201) {
      console.error('  上传失败 ' + f.rel + ' HTTP ' + b.status + ' ' + JSON.stringify(b.body).slice(0, 160));
      process.exit(1);
    }
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: b.body.sha });
    process.stdout.write('.');
  }
  console.log(' 完成');

  // 5) tree → commit → ref
  const t = await api('POST', `/repos/${OWNER}/${NAME}/git/trees`, { tree });
  if (t.status !== 201) { console.error('建 tree 失败: ' + JSON.stringify(t.body).slice(0, 300)); process.exit(1); }

  const commitMessage = [
    'Initial commit: DSH Desktop v1.4.1',
    '',
    '把 DeepSeek Harness 的 dsh web 界面封装成独立桌面应用：',
    '- 启动页：选择进入 Harness 或 DeepSeek 开放平台',
    '- Q 版助手：侧栏全身角色，漂浮/呼吸/摇摆动画，可拖动，气泡提醒余额、消耗与 token',
    '- 开放平台面板：余额、模型列表、流式对话测试、密钥管理',
    '- 视图互切：Harness ⇄ 开放平台（按钮 / 菜单 / Ctrl+Shift+P）',
    '- 后台服务用 WMI + wscript 拉起，独立于应用进程树，重启应用不断会话、不弹黑窗'
  ].join('\n');

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
