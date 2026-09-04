// index.js
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

require('./src/cli').main().catch((e) => {
  console.error(e);
  process.exit(1);
});
