import assert from "node:assert/strict";
import { settleInvoice } from "../src/ledger.js";
// Regression for invoice settlement: preserve amount and set settled.
assert.deepEqual(settleInvoice(7), { amount: 7, settled: true });
