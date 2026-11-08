/**
 * ensure-sqlite-prebuild.js
 *
 * better-sqlite3 是可选依赖：其自带 install 脚本在 Node 24 + VS 2026 环境下
 * 源码编译会失败（gyp 生成 ClangCL 工具集），npm 会跳过该可选依赖。
 * 本脚本在 postinstall 阶段自愈：
 *   1. 若包目录缺失 → 以 --ignore-scripts 安装（不触发编译）
 *   2. 若原生二进制缺失 → 下载 Electron ABI 官方预编译包（prebuild-install）
 * 应用运行在 Electron 中，只需要 Electron ABI 的二进制，无需本地编译。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkgDir = path.join(root, 'node_modules', 'better-sqlite3');
const nativeBin = path.join(pkgDir, 'build', 'Release', 'better_sqlite3.node');

function run(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'inherit', shell: true });
}

function main() {
  if (!fs.existsSync(pkgDir)) {
    console.log('[ensure-sqlite] better-sqlite3 缺失，安装中（跳过编译脚本）...');
    run('npm install better-sqlite3 --ignore-scripts --no-save', root);
  }
  if (fs.existsSync(nativeBin)) {
    console.log('[ensure-sqlite] 原生二进制已就绪，跳过。');
    return;
  }
  const electronVersion = require(path.join(
    root, 'node_modules', 'electron', 'package.json',
  )).version;
  console.log(`[ensure-sqlite] 下载 Electron ${electronVersion} 预编译包...`);
  run(`npx prebuild-install --runtime electron --target ${electronVersion}`, pkgDir);
  console.log('[ensure-sqlite] 完成。');
}

main();
