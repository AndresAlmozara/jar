import assert from 'node:assert/strict';
import { normalizeLabels } from './normalize.js';
assert.deepEqual(normalizeLabels([' A ', 'a', 'B']), ['a', 'b']);
