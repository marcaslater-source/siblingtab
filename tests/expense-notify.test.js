// Run with: node --experimental-strip-types tests/expense-notify.test.js   (Node 22+)
// Tests the expense-notify Edge Function with fake Supabase and a fake mailbox (nothing real is called).
const assert = require('assert');
(async () => {
  const { handle, buildEmail } = await import('../supabase/functions/expense-notify/index.ts');
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
  const reply = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
  const ID = '11111111-2222-3333-4444-555555555555';
  const payload = { family_name: 'The Slaters', actor_name: 'Sam', amount_cents: 123456, spent_on: '2026-11-24', category: 'medication',
    description: 'Pharmacy <b>', recipients: [{ email: 'a@x.com', unsub_token: 'tok-a' }, { email: 'b@x.com', unsub_token: 'tok-b' }] };
  function fake({ signedIn = true, pay = payload } = {}) {
    const calls = [];
    const f = async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/auth/v1/user')) return signedIn ? reply({ id: 'u1' }) : reply({}, 401);
      if (String(url).endsWith('/rpc/expense_alert_payload')) return reply(pay);
      throw new Error('unexpected ' + url);
    };
    return { f, calls };
  }
  const req = (body) => new Request('https://x/f', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: JSON.stringify(body) });

  let mails = []; const mailer = async (m) => { mails.push(m); };
  let t = fake(); let res = await handle(req({ expense_id: ID }), env, t.f, mailer);
  assert.deepStrictEqual(await res.json(), { sent: 2, failed: 0 });
  assert.deepStrictEqual(mails.map((m) => m.to), ['a@x.com', 'b@x.com']);
  assert.ok(mails[0].text.includes('Sam added a new expense to The Slaters') && mails[0].text.includes('$1,234.56'));
  assert.ok(mails[0].html.includes('Pharmacy &lt;b&gt;'), 'description is escaped');
  assert.ok(mails[0].text.includes('#/unsubscribe-expenses/tok-a') && mails[1].text.includes('tok-b'));
  assert.ok(!/owe/i.test(mails[0].text + mails[0].html), 'neutral wording');
  assert.ok(mails[0].headers['List-Unsubscribe'].includes('tok-a'));

  mails = []; t = fake({ pay: null }); res = await handle(req({ expense_id: ID }), env, t.f, mailer);
  assert.deepStrictEqual(await res.json(), { sent: 0 }); assert.strictEqual(mails.length, 0);
  mails = []; t = fake({ pay: { ...payload, recipients: [] } }); res = await handle(req({ expense_id: ID }), env, t.f, mailer);
  assert.deepStrictEqual(await res.json(), { sent: 0 }); assert.strictEqual(mails.length, 0);
  t = fake({ signedIn: false }); res = await handle(req({ expense_id: ID }), env, t.f, mailer); assert.strictEqual(res.status, 401);
  assert.ok(!t.calls.some((c) => c.includes('expense_alert_payload')), 'not signed in: database never asked');
  t = fake(); res = await handle(req({ expense_id: 'nope' }), env, t.f, mailer); assert.strictEqual(res.status, 400);
  // one failed address does not stop the rest
  let n = 0; res = await handle(req({ expense_id: ID }), env, fake().f, async () => { if (n++ === 0) throw new Error('boom'); });
  assert.deepStrictEqual(await res.json(), { sent: 1, failed: 1 });
  console.log('expense-notify: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
