// 用 @electron/packager 的 API 打包（比命令行更好处理忽略规则与元数据）
// 用法: node tools/package.js [--out <目录>]
//
// 产物: dist/DSH Desktop-win32-x64/DSH Desktop.exe
// 应用本身没有运行时依赖（只用 Electron 内置模块），所以 node_modules 全部排除。

const path = require('path');
const fs = require('fs');

// --out <dir> 指定输出目录（默认 dist）；程序正在运行时 dist 会被占用，
// 可以先打包到临时目录，再只替换 resources/app.asar（见 update-app.js）
function outDirArg(defaultDir) {
  const i = process.argv.indexOf('--out');
  if (i !== -1 && process.argv[i + 1]) return path.resolve(process.argv[i + 1]);
  return defaultDir;
}

async function main() {
  // @electron/get 默认从 github.com 拉 Electron 发行包，国内经常超时；
  // 未显式指定镜像时走 npmmirror。
  if (!process.env.ELECTRON_MIRROR) {
    process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
  }

  // 动态导入：@electron/packager 是 ESM，且只有具名导出
  const { packager } = await import('@electron/packager');

  const root = path.join(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  const out = await packager({
    dir: root,
    name: pkg.productName || 'DSH Desktop',
    appVersion: pkg.version,
    platform: 'win32',
    arch: 'x64',
    icon: path.join(root, 'assets', 'icon.ico'),
    out: outDirArg(path.join(root, 'dist')),
    overwrite: true,
    prune: true,
    asar: true,
    ignore: [
      /^\/node_modules($|\/)/,
      /^\/dist($|\/)/,
      /^\/dist-build($|\/)/,
      /^\/dist-new($|\/)/,
      /^\/\.preview($|\/)/,
      /^\/tools($|\/)/,
      // 图标素材：运行时只需要 icon.ico / icon.png / icon-32.png
      /^\/assets\/generated($|\/)/,
      /^\/assets\/icon-source\.(jpg|jpeg|png|webp)$/i,
      /^\/package-lock\.json$/,
      /^\/README\.md$/,
      /^\/\.gitignore$/
    ],
    win32metadata: {
      CompanyName: 'DSH',
      FileDescription: 'DeepSeek Harness Desktop',
      ProductName: pkg.productName || 'DSH Desktop',
      OriginalFilename: 'DSH Desktop.exe',
      InternalName: 'DSH Desktop'
    }
  });

  for (const dir of out) {
    const size = require('child_process')
      .execSync(`powershell -NoProfile -Command "(Get-ChildItem -LiteralPath '${dir}' -Recurse -File | Measure-Object Length -Sum).Sum"`)
      .toString().trim();
    console.log('打包完成: ' + dir);
    console.log('总大小: ' + (Number(size) / 1024 / 1024).toFixed(1) + ' MB');
    console.log('可执行文件: ' + path.join(dir, (pkg.productName || 'DSH Desktop') + '.exe'));
  }
}

main().catch((err) => {
  console.error('打包失败:', err);
  process.exit(1);
});
