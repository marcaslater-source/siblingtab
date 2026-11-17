// Run with: node --experimental-strip-types tests/read-receipt.test.js   (Node 22+)
// Tests the read-receipt Edge Function with fake Supabase and a fake AI reply (nothing real is called).
const assert = require('assert');
(async () => {
  const { handle, cleanResult, CATEGORIES } = await import('../supabase/functions/read-receipt/index.ts');
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', ANTHROPIC_API_KEY: 'sk-test' };
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status });
  function fake({ signedIn = true, verdict = 'ok', ai } = {}) {
    const calls = [];
    const f = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/auth/v1/user')) return signedIn ? reply({ id: 'u1' }) : reply({}, 401);
      if (String(url).endsWith('/rpc/claim_receipt_scan')) return reply(verdict);
      if (String(url).includes('api.anthropic.com')) return ai ? ai() : reply({ content: [{ type: 'tool_use', input: { is_receipt: true, total: 47.3, date: '2026-10-05', store: 'Shoppers', summary: 'prescription', category: 'medication' } }] });
      throw new Error('unexpected ' + url);
    };
    return { f, calls };
  }
  const req = (body, headers = { Authorization: 'Bearer t' }) => new Request('https://x/f', { method: 'POST', headers, body: JSON.stringify(body) });
  const good = { image: 'QUJD', media_type: 'image/jpeg' };

  // happy path
  let t = fake(); let res = await handle(req(good), env, t.f);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { found: true, amount: 47.3, date: '2026-10-05', description: 'Shoppers – prescription', category: 'medication' });
  const sent = JSON.parse(t.calls[2].init.body);
  assert.strictEqual(sent.model, 'claude-sonnet-5-5'); assert.ok(sent.max_tokens <= 300);
  assert.strictEqual(t.calls[2].init.headers['x-api-key'], 'sk-test');

  // not signed in -> never reaches the AI
  t = fake({ signedIn: false }); res = await handle(req(good), env, t.f);
  assert.strictEqual(res.status, 401); assert.ok(!t.calls.some(c => c.url.includes('anthropic')));
  // daily limit -> never reaches the AI
  t = fake({ verdict: 'user_limit' }); res = await handle(req(good), env, t.f);
  assert.strictEqual(res.status, 429); assert.strictEqual((await res.json()).error, 'daily_limit'); assert.ok(!t.calls.some(c => c.url.includes('anthropic')));
  t = fake({ verdict: 'global_limit' }); res = await handle(req(good), env, t.f);
  assert.strictEqual(res.status, 429); assert.ok(!t.calls.some(c => c.url.includes('anthropic')));
  // bad inputs
  for (const bad of [{}, { image: 'QUJD', media_type: 'application/pdf' }, { image: '<script>', media_type: 'image/jpeg' }, { image: 'A'.repeat(1500001), media_type: 'image/jpeg' }]) {
    t = fake(); res = await handle(req(bad), env, t.f); assert.strictEqual(res.status, 400);
    assert.ok(!t.calls.some(c => c.url.includes('anthropic') || c.url.includes('claim_receipt')));
  }
  // AI down / garbage -> graceful errors
  t = fake({ ai: () => reply({}, 500) }); res = await handle(req(good), env, t.f); assert.strictEqual(res.status, 502);
  t = fake({ ai: () => reply({ content: [{ type: 'text', text: 'hi' }] }) }); res = await handle(req(good), env, t.f); assert.strictEqual(res.status, 422);
  // missing key
  res = await handle(req(good), { ...env, ANTHROPIC_API_KEY: undefined }, fake().f); assert.strictEqual(res.status, 503);
  // The key must never be echoed back
  t = fake(); res = await handle(req(good), env, t.f); assert.ok(!(await res.text()).includes('sk-test'));

  // cleaning
  const today = '2026-11-17';
  assert.deepStrictEqual(cleanResult({ is_receipt: false }, today), { found: false });
  assert.deepStrictEqual(cleanResult({ is_receipt: true, total: -4, date: '2027-01-01', store: ' ', category: 'nope' }, today),
    { found: true, amount: null, date: null, description: null, category: 'other' });
  assert.strictEqual(cleanResult({ total: 10.456, category: 'transport' }, today).amount, 10.46);
  assert.ok(CATEGORIES.includes('equipment'));
  console.log('read-receipt tests ok');
})().catch(e => { console.error(e); process.exit(1); });
