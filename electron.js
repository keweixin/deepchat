const fs = require('fs');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';
const distMain = path.join(__dirname, 'dist-electron', 'main.js');

if (isDev) {
  require('tsx/cjs/api').register();
  require('./electron/main.ts');
} else if (fs.existsSync(distMain)) {
  require(distMain);
} else {
  throw new Error(`生产构建产物缺失：${distMain}\n请先运行构建命令：npm run build:electron`);
}
