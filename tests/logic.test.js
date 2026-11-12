// Run with: node tests/logic.test.js
const assert = require('assert');
const L = require('../app/logic.js');

assert.strictEqual(L.parseCents('24.99'), 2499);
assert.strictEqual(L.parseCents('$1,234.5'), 123450);
assert.strictEqual(L.parseCents('.5'), 50);
assert.strictEqual(L.parseCents('10'), 1000);
assert.strictEqual(L.parseCents('0'), null);
assert.strictEqual(L.parseCents('-5'), null);
assert.strictEqual(L.parseCents('1.234'), null);
assert.strictEqual(L.parseCents('abc'), null);
assert.strictEqual(L.parseCents('100000.01'), null);
assert.strictEqual(L.formatCents(123456), '$1,234.56');
assert.strictEqual(L.formatCents(-5), '-$0.05');

assert.deepStrictEqual(L.evenSplit(10001, ['a', 'b']).map(s => s.share_cents), [5001, 5000]);
assert.deepStrictEqual(L.evenSplit(100, ['a', 'b', 'c']).map(s => s.share_cents), [34, 33, 33]);

// A paid 90 split 3 ways, B paid 30 split A+B; C paid A back 10.
const exp = [{ id: 'e1', paid_by: 'A', amount_cents: 9000 }, { id: 'e2', paid_by: 'B', amount_cents: 3000 }];
const sh = [
  { expense_id: 'e1', user_id: 'A', share_cents: 3000 }, { expense_id: 'e1', user_id: 'B', share_cents: 3000 }, { expense_id: 'e1', user_id: 'C', share_cents: 3000 },
  { expense_id: 'e2', user_id: 'A', share_cents: 1500 }, { expense_id: 'e2', user_id: 'B', share_cents: 1500 }];
const st = [{ from_user: 'C', to_user: 'A', amount_cents: 1000 }];
const net = L.netBalances(['A', 'B', 'C'], exp, sh, st);
assert.deepStrictEqual(net, { A: 3500, B: -1500, C: -2000 });
assert.strictEqual(Object.values(net).reduce((a, b) => a + b, 0), 0);
assert.deepStrictEqual(L.whoOwesWhom(net), [
  { from: 'C', to: 'A', amount_cents: 2000 }, { from: 'B', to: 'A', amount_cents: 1500 }]);
assert.deepStrictEqual(L.whoOwesWhom({ A: 0, B: 0 }), []);

const csv = L.buildCsv(
  [{ user_id: 'A', display_name: 'Marc' }, { user_id: 'B', display_name: 'Sis, "J"' }],
  [{ id: 'e1', paid_by: 'A', amount_cents: 1001, spent_on: '2026-03-01', category: 'medication', description: '=HYPERLINK("x")', receipt_path: 'f/x.jpg' },
   { id: 'e2', paid_by: 'B', amount_cents: 500, spent_on: '2025-12-31', category: 'other', description: 'old', receipt_path: null }],
  [{ expense_id: 'e1', user_id: 'A', share_cents: 501 }, { expense_id: 'e1', user_id: 'B', share_cents: 500 }],
  [{ from_user: 'B', to_user: 'A', amount_cents: 500, settled_on: '2026-04-01', note: 'e-Transfer' }], '2026');
const lines = csv.trim().split('\r\n');
assert.strictEqual(lines.length, 3);
assert.ok(lines[0].endsWith('Marc share,"Sis, ""J"" share"'));
assert.ok(lines[1].includes(`"'=HYPERLINK(""x"")"`), lines[1]);
assert.ok(lines[1].includes('Medication & pharmacy,') && lines[1].endsWith('Yes,5.01,5.00'));
assert.ok(lines[2].startsWith('Payment between family,2026-04-01,,e-Transfer,5.00,"Sis, ""J""",Marc'));
console.log('logic tests passed');
