#!/usr/bin/env node
/** `npm run setup` — install every npm and non-npm dependency needed to run. */
'use strict';
const path = require('path');
const { setup } = require('../sdk/logic/app-scripts');

setup({
  appName: "ai-mentat-roblox-studio",
  root: path.resolve(__dirname, '..'),
  system: [],
  extra: undefined,
});
