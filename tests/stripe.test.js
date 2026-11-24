// Run with: node --experimental-strip-types tests/stripe.test.js   (Node 22+)
// Tests the two Stripe functions with fake Supabase and fake Stripe (nothing real is called).
const assert = require('assert');
const crypto = require('crypto');
(async () => {
  const co = await import('../supabase/functions/stripe-checkout/index.ts');
  const wh = await import('../supabase/functions/stripe-webhook/index.ts');
  const FID = '11111111-1111-1111-1111-111111111111';
  const reply = (o, status = 200) => new Response(JSON.stringify(o), { status });
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test' };

  // ---- checkout
  function fake({ role = 'owner', billing = [], signedIn = true } = {}) {
    const calls = [];
    const f = async (url, init) => {
      url = String(url); calls.push({ url, init });
      if (url.endsWith('/auth/v1/user')) return signedIn ? reply({ id: 'u1', email: 'a@b.c' }) : reply({}, 401);
      if (url.includes('/rest/v1/family_members')) return reply(role ? [{ role }] : []);
      if (url.includes('/rest/v1/family_billing?select')) return reply(billing);
      if (url.includes('/rest/v1/family_billing')) return reply({}, 201);
      if (url.endsWith('/v1/customers')) return reply({ id: 'cus_1' });
      if (url.endsWith('/checkout/sessions')) return reply({ url: 'https://checkout.stripe.com/c/1' });
      if (url.endsWith('/billing_portal/sessions')) return reply({ url: 'https://billing.stripe.com/p/1' });
      throw new Error('unexpected ' + url);
    };
    return { f, calls };
  }
  const req = (body, h = { Authorization: 'Bearer t' }) => new Request('https://x/f', { method: 'POST', headers: h, body: JSON.stringify(body) });

  let t = fake(); let res = await co.handle(req({ family_id: FID, action: 'checkout' }), env, t.f);
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).url, 'https://checkout.stripe.com/c/1');
  const sess = t.calls.find((c) => c.url.endsWith('/checkout/sessions')).init.body;
  assert.ok(sess.includes('trial_period_days%5D=14') && sess.includes('unit_amount%5D=800') && sess.includes('cad'), 'trial, $8, CAD');
  assert.ok(!sess.includes('sk_test'), 'no secrets in body');

  t = fake({ role: 'member' }); res = await co.handle(req({ family_id: FID, action: 'checkout' }), env, t.f);
  assert.strictEqual(res.status, 403);
  t = fake({ signedIn: false }); res = await co.handle(req({ family_id: FID, action: 'checkout' }), env, t.f);
  assert.strictEqual(res.status, 401);
  t = fake(); res = await co.handle(req({ family_id: 'nope', action: 'checkout' }), env, t.f);
  assert.strictEqual(res.status, 400);
  t = fake({ billing: [{ stripe_customer_id: 'cus_9', status: 'active' }] });
  res = await co.handle(req({ family_id: FID, action: 'checkout' }), env, t.f);
  assert.strictEqual(res.status, 409);
  res = await co.handle(req({ family_id: FID, action: 'portal' }), env, t.f);
  assert.strictEqual((await res.json()).url, 'https://billing.stripe.com/p/1');
  res = await co.handle(req({ family_id: FID, action: 'checkout' }), { ...env, STRIPE_SECRET_KEY: undefined }, t.f);
  assert.strictEqual(res.status, 503);

  // ---- webhook
  const sign = (payload, secret = env.STRIPE_WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000)) =>
    `t=${ts},v1=${crypto.createHmac('sha256', secret).update(ts + '.' + payload).digest('hex')}`;
  const sub = { id: 'sub_1', customer: 'cus_1', status: 'trialing', trial_end: 1800000000, current_period_end: 1800000000, cancel_at_period_end: false, metadata: { family_id: FID } };
  function wfake(ok = true) {
    const calls = [];
    return { calls, f: async (url, init) => { calls.push({ url: String(url), init }); return String(url).includes('api.stripe.com') ? reply(sub) : new Response('', { status: ok ? 201 : 500 }); } };
  }
  const post = (payload, sig) => new Request('https://x/w', { method: 'POST', headers: { 'Stripe-Signature': sig }, body: payload });

  let p = JSON.stringify({ type: 'customer.subscription.updated', data: { object: sub } });
  let w = wfake(); res = await wh.handle(post(p, sign(p)), env, w.f);
  assert.strictEqual(res.status, 200);
  const saved = JSON.parse(w.calls[0].init.body);
  assert.strictEqual(saved.family_id, FID); assert.strictEqual(saved.status, 'trialing'); assert.strictEqual(saved.stripe_customer_id, 'cus_1');

  res = await wh.handle(post(p, sign(p, 'whsec_wrong')), env, wfake().f); assert.strictEqual(res.status, 400);
  res = await wh.handle(post(p, sign(p, env.STRIPE_WEBHOOK_SECRET, 1000)), env, wfake().f); assert.strictEqual(res.status, 400, 'old timestamp');
  res = await wh.handle(post(p + ' ', sign(p)), env, wfake().f); assert.strictEqual(res.status, 400, 'tampered body');
  res = await wh.handle(post(p, sign(p)), env, wfake(false).f); assert.strictEqual(res.status, 502, 'db failure -> Stripe retries');

  p = JSON.stringify({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', client_reference_id: FID } } });
  w = wfake(); res = await wh.handle(post(p, sign(p)), env, w.f);
  assert.strictEqual(res.status, 200); assert.ok(w.calls[0].url.includes('/subscriptions/sub_1'));

  p = JSON.stringify({ type: 'invoice.paid', data: { object: {} } });
  res = await wh.handle(post(p, sign(p)), env, wfake().f); assert.strictEqual(res.status, 200);
  console.log('stripe tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
