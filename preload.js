const fs = require('fs');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';
const distPreload = path.join(__dirname, 'dist-electron', 'preload.js');

if (isDev || !fs.existsSync(distPreload)) {
  require('tsx/cjs/api').register();
  require('./electron/preload.ts');
} else {
  require(distPreload);
}
