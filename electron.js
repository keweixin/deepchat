const fs = require('fs');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';
const distMain = path.join(__dirname, 'dist-electron', 'main.js');

if (isDev || !fs.existsSync(distMain)) {
  require('tsx/cjs/api').register();
  require('./electron/main.ts');
} else {
  require(distMain);
}
