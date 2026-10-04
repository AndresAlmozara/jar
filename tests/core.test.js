import test from "node:test"; import assert from "node:assert/strict";
import { stableStringify, sha256, assertTaskSnapshot } from "../packages/core/src/index.js";
test("stable hash ignores object key order",()=>{assert.equal(sha256({b:2,a:1}),sha256({a:1,b:2}))});
test("task snapshot validation",()=>{assert.equal(assertTaskSnapshot({id:"t",text:"x"}).id,"t");assert.throws(()=>assertTaskSnapshot({id:"t"}))});
