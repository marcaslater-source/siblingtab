// SiblingTab billing, part 1: starts a Stripe Checkout page or the Stripe billing portal.
// Edge Function "stripe-checkout". Leave "Verify JWT" ON (only signed-in people can call it).
// Body: { family_id, action: 'checkout' | 'portal' }  -> returns { url } to send the browser to.
// Only the person who started the family space (its owner) can do this.
//
// Secrets (Edge Functions -> Secrets):
//   STRIPE_SECRET_KEY   sk_test_... while testing (sk_live_... only at launch)
// Optional: STRIPE_PRICE_ID (use a price made in the Stripe Dashboard; otherwise $8 CAD/month is built in),
//           TRIAL_DAYS (default 14), APP_URL (default https://app.siblingtab.com/)
// Supabase fills in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY by itself.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

export async function handle(req: Request, env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'bad_request' }, 405);
  const url = env.SUPABASE_URL, svc = env.SUPABASE_SERVICE_ROLE_KEY, sk = env.STRIPE_SECRET_KEY;
  if (!url || !svc || !sk) return json({ error: 'not_set_up' }, 503);

  const auth = req.headers.get('Authorization') || '';
  const who = await fetchFn(url + '/auth/v1/user', { headers: { Authorization: auth, apikey: svc } });
  if (!who.ok) return json({ error: 'not_signed_in' }, 401);
  const user = await who.json();
  if (!user || !user.id) return json({ error: 'not_signed_in' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const fid = body && body.family_id, action = body && body.action;
  if (typeof fid !== 'string' || !/^[0-9a-f-]{36}$/i.test(fid) || !['checkout', 'portal'].includes(action)) {
    return json({ error: 'bad_request' }, 400);
  }

  const svcHeaders = { Authorization: 'Bearer ' + svc, apikey: svc, 'Content-Type': 'application/json' };
  // Must be the owner of this family.
  const mem = await fetchFn(`${url}/rest/v1/family_members?select=role&family_id=eq.${fid}&user_id=eq.${user.id}&left_at=is.null`, { headers: svcHeaders });
  if (!mem.ok) return json({ error: 'unavailable' }, 502);
  const rows = await mem.json();
  if (!Array.isArray(rows) || !rows.length || rows[0].role !== 'owner') return json({ error: 'owner_only' }, 403);

  const stripe = (path: string, params: Record<string, string>) => fetchFn('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + sk, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params)
  });
  const app = env.APP_URL || 'https://app.siblingtab.com/';

  // Existing billing row?
  const br = await fetchFn(`${url}/rest/v1/family_billing?select=stripe_customer_id,status&family_id=eq.${fid}`, { headers: svcHeaders });
  if (!br.ok) return json({ error: 'unavailable' }, 502);
  const billing = (await br.json())[0] || null;
  let customer: string | null = billing && billing.stripe_customer_id;

  if (!customer) {
    const c = await stripe('customers', { email: user.email || '', 'metadata[family_id]': fid });
    if (!c.ok) return json({ error: 'unavailable' }, 502);
    customer = (await c.json()).id;
    const save = await fetchFn(url + '/rest/v1/family_billing?on_conflict=family_id', {
      method: 'POST',
      headers: { ...svcHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ family_id: fid, stripe_customer_id: customer })
    });
    if (!save.ok) return json({ error: 'unavailable' }, 502);
  }

  if (action === 'portal') {
    const p = await stripe('billing_portal/sessions', { customer: customer!, return_url: app + '#/f/' + fid + '/family' });
    if (!p.ok) return json({ error: 'unavailable' }, 502);
    return json({ url: (await p.json()).url });
  }

  if (billing && ['trialing', 'active', 'past_due'].includes(billing.status)) return json({ error: 'already_subscribed' }, 409);
  const trial = String(parseInt(env.TRIAL_DAYS || '14', 10) || 14);
  const params: Record<string, string> = {
    mode: 'subscription', customer: customer!, client_reference_id: fid,
    success_url: app + '#/f/' + fid + '/family', cancel_url: app + '#/f/' + fid + '/family',
    'subscription_data[trial_period_days]': trial, 'subscription_data[metadata][family_id]': fid,
    'line_items[0][quantity]': '1', billing_address_collection: 'auto'
  };
  if (env.STRIPE_PRICE_ID) params['line_items[0][price]'] = env.STRIPE_PRICE_ID;
  else {
    params['line_items[0][price_data][currency]'] = 'cad';
    params['line_items[0][price_data][unit_amount]'] = '800';
    params['line_items[0][price_data][recurring][interval]'] = 'month';
    params['line_items[0][price_data][product_data][name]'] = 'SiblingTab family plan';
  }
  const s = await stripe('checkout/sessions', params);
  if (!s.ok) return json({ error: 'unavailable' }, 502);
  return json({ url: (await s.json()).url });
}

// @ts-ignore: Deno is provided by Supabase when the function runs
if (typeof Deno !== 'undefined') Deno.serve((req: Request) => handle(req, Deno.env.toObject()));
