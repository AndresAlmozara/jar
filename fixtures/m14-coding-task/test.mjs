import assert from 'node:assert/strict';
import { add } from './math.js';

assert.equal(add(2, 3), 5);
assert.equal(add(-4, 1), -3);
console.log('fixture tests passed');
