#!/bin/sh
set -eu
mkdir -p /work
tar -C /source --exclude=.git --exclude=.test-tools --exclude=node_modules --exclude=test-results --exclude=v2ray-config.json -cf - . | tar -C /work -xf -
cd /work
npm ci --ignore-scripts --no-audit --no-fund
mkdir -p .test-tools
cp /source/.test-tools/v2ray-linux-64/v2ray .test-tools/v2ray
cp /source/.test-tools/Xray-linux-64/xray .test-tools/xray
chmod 700 .test-tools/v2ray .test-tools/xray
npm run check
npm run check:types
npm run check:config
npm test
npm run test:interop
npm run test:package
