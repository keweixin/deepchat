const fs = require('fs');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';
const distPreload = path.join(__dirname, 'dist-electron', 'preload.js');

if (isDev) {
  require('tsx/cjs/api').register();
  require('./electron/preload.ts');
} else if (fs.existsSync(distPreload)) {
  require(distPreload);
} else {
  throw new Error(`生产构建产物缺失：${distPreload}`);
}
