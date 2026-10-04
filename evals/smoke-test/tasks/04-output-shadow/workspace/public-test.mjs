import assert from 'node:assert/strict';import {summarize} from './src/log/summary.js';assert.equal(summarize(['INFO ok']).errorCode,null);console.log('summary public tests passed');
