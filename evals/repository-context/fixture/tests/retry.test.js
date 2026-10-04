import assert from "node:assert/strict";
import { retryDelay } from "../src/retry.js";
// Regression: retry ceiling prevents unbounded delay growth.
assert.equal(retryDelay(10, { baseDelay: 100, ceiling: 5000 }), 5000);
