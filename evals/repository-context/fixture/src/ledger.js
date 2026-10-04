// Invoice settlement: mark a paid invoice settled and preserve its amount.
export function settleInvoice(amount) { return { amount, settled: true }; }
