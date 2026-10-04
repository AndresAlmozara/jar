import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const {normalizeLabels}=await import(pathToFileURL(resolve(process.argv[2],'normalize.js')));
const input=[' B ', '', 'b', ' A ', 'a', '  '];
assert.deepEqual(normalizeLabels(input),['b','a']);
assert.deepEqual(input,[' B ', '', 'b', ' A ', 'a', '  ']);
assert.deepEqual(normalizeLabels([]),[]);
assert.deepEqual(normalizeLabels([' X\t','x',' Y ']),['x','y']);
