// SiblingTab billing, part 2: Stripe tells us when a subscription starts, renews, fails or ends,
// and this keeps the family's plan status up to date. Edge Function "stripe-webhook".
// IMPORTANT: turn "Verify JWT" OFF for this one (Stripe is not a SiblingTab user). Safety comes
// from checking Stripe's signature instead, so a request without a valid signature is rejected.
//
// Secrets: STRIPE_WEBHOOK_SECRET (whsec_..., from the Stripe webhook endpoint). Supabase fills in the rest.
// Stripe events to send: checkout.session.completed, customer.subscription.created,
// customer.subscription.updated, customer.subscription.deleted

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

// Checks Stripe's "Stripe-Signature" header (HMAC-SHA256 of "<timestamp>.<body>") and that it is recent.
export async function verifySignature(payload: string, header: string, secret: string, nowSec = Math.floor(Date.now() / 1000), tolerance = 300) {
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = parts.find((p) => p[0] === 't')?.[1];
  const sigs = parts.filter((p) => p[0] === 'v1').map((p) => p[1]);
  if (!t || !sigs.length || Math.abs(nowSec - Number(t)) > tolerance) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(t + '.' + payload)));
  return sigs.some((s) => s.length === expected.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0);
}

const iso = (s: any) => (typeof s === 'number' ? new Date(s * 1000).toISOString() : null);

// Turns a Stripe subscription into the row we store.
export function subscriptionRow(sub: any, familyId: string) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  return {
    family_id: familyId,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id,
    stripe_subscription_id: sub.id,
    status: sub.status,
    trial_end: iso(sub.trial_end),
    current_period_end: iso(sub.current_period_end ?? (item && item.current_period_end)),
    cancel_at_period_end: !!sub.cancel_at_period_end,
    updated_at: new Date().toISOString()
  };
}

export async function handle(req: Request, env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const url = env.SUPABASE_URL, svc = env.SUPABASE_SERVICE_ROLE_KEY, secret = env.STRIPE_WEBHOOK_SECRET;
  if (!url || !svc || !secret) return new Response('not set up', { status: 503 });

  const payload = await req.text();
  if (!(await verifySignature(payload, req.headers.get('Stripe-Signature') || '', secret))) return new Response('bad signature', { status: 400 });
  let event: any;
  try { event = JSON.parse(payload); } catch { return new Response('bad json', { status: 400 }); }

  const obj = event.data && event.data.object;
  let sub: any = null, familyId: string | null = null;
  if (event.type === 'checkout.session.completed' && obj && obj.mode === 'subscription' && obj.subscription) {
    // The session only names the subscription; ask Stripe for the full details.
    const sk = env.STRIPE_SECRET_KEY;
    if (!sk) return new Response('not set up', { status: 503 });
    const r = await fetchFn('https://api.stripe.com/v1/subscriptions/' + encodeURIComponent(obj.subscription), { headers: { Authorization: 'Bearer ' + sk } });
    if (!r.ok) return new Response('retry', { status: 502 });
    sub = await r.json();
    familyId = obj.client_reference_id || (sub.metadata && sub.metadata.family_id) || null;
  } else if (/^customer\.subscription\.(created|updated|deleted)$/.test(event.type) && obj) {
    sub = obj;
    familyId = (sub.metadata && sub.metadata.family_id) || null;
  } else {
    return new Response('ignored', { status: 200 });
  }
  if (!familyId || !/^[0-9a-f-]{36}$/i.test(familyId)) return new Response('no family', { status: 200 });

  const save = await fetchFn(url + '/rest/v1/family_billing?on_conflict=family_id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + svc, apikey: svc, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(subscriptionRow(sub, familyId))
  });
  // A non-2xx makes Stripe retry later, which is what we want if the database hiccups.
  return save.ok ? new Response('ok', { status: 200 }) : new Response('retry', { status: 502 });
}

// @ts-ignore: Deno is provided by Supabase when the function runs
if (typeof Deno !== 'undefined') Deno.serve((req: Request) => handle(req, Deno.env.toObject()));
