// 项目静态自检：EJS 模板编译、JS 语法、版本一致性、悬空引用、遗留文件
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const out = [];
const ok = (name, cond, detail) => out.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? '  -- ' + detail : ''));

// 1) 所有 EJS 模板可编译
const viewsDir = path.join(ROOT, 'src', 'views');
const views = fs.readdirSync(viewsDir).filter((f) => f.endsWith('.ejs'));
let ejsFail = 0;
for (const v of views) {
  try {
    execFileSync(process.execPath, ['-e', `require('ejs').compile(require('fs').readFileSync('src/views/${v}','utf8'),{filename:'src/views/${v}'})`], { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    ejsFail++;
    ok(`模板编译 ${v}`, false, String(e.stderr || e.message).slice(0, 120));
  }
}
ok(`全部 ${views.length} 个 EJS 模板编译通过`, ejsFail === 0);

// 2) 所有 JS 语法检查（src + public + 根目录 server.js + test）
const jsFiles = [];
function walk(dir, depth) {
  if (depth > 3) return;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.name === 'node_modules' || f.name.startsWith('data') || f.name === 'dist' || f.name === 'fpk-work') continue;
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, depth + 1);
    else if (f.name.endsWith('.js')) jsFiles.push(p);
  }
}
walk(ROOT, 0);
let synFail = 0;
for (const f of jsFiles) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { synFail++; ok(`语法 ${path.relative(ROOT, f)}`, false, String(e.stderr || e.message).slice(0, 120)); }
}
ok(`全部 ${jsFiles.length} 个 JS 文件语法通过`, synFail === 0);

// 3) 版本一致性：package.json vs about.js CHANGELOG 头部
const pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const aboutSrc = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'about.js'), 'utf8');
const m = aboutSrc.match(/version:\s*'([^']+)'/);
ok(`版本一致（package.json ${pkgVer} = CHANGELOG 头部 ${m ? m[1] : '?'}）`, !!m && m[1] === pkgVer);

// 4) 悬空引用：已删除的视图不再被路由引用
const routeSrc = fs.readdirSync(path.join(ROOT, 'src', 'routes')).map((f) => fs.readFileSync(path.join(ROOT, 'src', 'routes', f), 'utf8')).join('\n') + fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
ok('无对已删除 admin.ejs 的渲染引用', !routeSrc.includes("render('admin'"));
ok('侧栏无独立 /admin 入口', !fs.readFileSync(path.join(ROOT, 'src', 'views', 'layout.ejs'), 'utf8').includes('href="/admin"'));
ok('无旧版 appVersion 资源引用（应全用 assetV）', !fs.readFileSync(path.join(ROOT, 'src', 'views', 'layout.ejs'), 'utf8').includes('app.css?v=<%= appVersion') && !fs.readFileSync(path.join(ROOT, 'src', 'views', 'layout.ejs'), 'utf8').includes('app.js?v=<%= appVersion'));

// 5) 关键视图存在
for (const v of ['layout.ejs', 'layout-blank.ejs', 'settings.ejs', 'about.ejs', 'dashboard.ejs', 'login.ejs'])
  ok(`关键视图存在 ${v}`, fs.existsSync(path.join(viewsDir, v)));

// 6) 根目录无遗留临时文件
const tempPatterns = [/^verify-.*\.(txt|out|err|code)$/, /^shot-.*\.(js|txt)$/, /^e2e-.*\.(js|txt)$/, /^probe.*\.(js|txt)$/, /^preview-check\.txt$/, /^test-avatar\.png$/, /^verify-.*\.out$/];
const leftovers = fs.readdirSync(ROOT).filter((f) => tempPatterns.some((re) => re.test(f)));
ok('根目录无遗留临时文件', leftovers.length === 0, leftovers.join(', ') || '');

// 7) 静态资源与数据目录约定
ok('public/css/app.css 与 public/js/app.js 存在', fs.existsSync(path.join(ROOT, 'public/css/app.css')) && fs.existsSync(path.join(ROOT, 'public/js/app.js')));
ok('fpk 打包脚本存在', fs.existsSync(path.join(ROOT, 'packaging/fpk/make-fpk.py')));

console.log(out.join('\n'));
const fails = out.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n=== 静态自检：${out.length - fails} 通过 / ${fails} 失败 ===`);
process.exit(fails ? 1 : 0);
