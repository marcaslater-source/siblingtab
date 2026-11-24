// SiblingTab automatic receipt reading. Runs as a Supabase Edge Function ("read-receipt").
// The app sends one shrunken receipt photo; this asks a Claude model to read the amount, date,
// store and a suggested category, and returns them for the person to review. Nothing is saved here:
// the photo is not stored and the result is not stored (only a "scanned once" counter with how it ended,
// for daily limits and the owner's aggregate stats).
//
// Secrets (Edge Functions -> Secrets):
//   ANTHROPIC_API_KEY   created by the owner in the Anthropic Console, with a monthly spend limit
// Optional: RECEIPT_MODEL (default claude-sonnet-5-5), RECEIPT_USER_DAILY (default 15), RECEIPT_GLOBAL_DAILY (default 300)
// Supabase fills in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY by itself. Leave "Verify JWT" ON.

export const CATEGORIES = ['medication', 'medical', 'care_home', 'home_care', 'transport', 'groceries', 'home', 'equipment', 'other'];
const MEDIA = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_B64 = 1_500_000; // ~1.1 MB image: the app sends far less

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

const TOOL = {
  name: 'record_receipt',
  description: 'Record what is printed on the receipt. Use null for anything that is not clearly readable.',
  input_schema: {
    type: 'object',
    properties: {
      is_receipt: { type: 'boolean', description: 'false if the image is not a receipt or invoice' },
      total: { type: ['number', 'null'], description: 'Final total paid in Canadian dollars, including tax and tip' },
      date: { type: ['string', 'null'], description: 'Purchase date as YYYY-MM-DD' },
      store: { type: ['string', 'null'], description: 'Store or business name only' },
      category: { type: 'string', enum: CATEGORIES },
      summary: { type: ['string', 'null'], description: 'At most 6 words on what was bought, no personal or health details' }
    },
    required: ['is_receipt', 'total', 'date', 'store', 'category']
  }
};

const PROMPT = 'Read this receipt for a family keeping track of care costs for a parent. ' +
  'Categories: medication = pharmacy/prescriptions; medical = doctor, dental, clinic, physio, hospital; ' +
  'care_home = retirement or care residence fees; home_care = personal support workers, cleaners, respite; ' +
  'transport = taxi, parking, gas, transit; groceries = food and meals; home = repairs, renovation, utilities; ' +
  'equipment = mobility aids, medical supplies, devices; other = anything else. ' +
  'Give the final total actually paid. Dates are Canadian: if day/month is ambiguous, prefer the reading that is not in the future. ' +
  'Never guess: use null when unsure. Call record_receipt.';

// Turns the model's answer into safe, clean fields. Anything doubtful becomes null so the app leaves that box empty.
export function cleanResult(r: any, todayIso: string) {
  r = r && typeof r === 'object' ? r : {};
  if (r.is_receipt === false) return { found: false };
  let amount = typeof r.total === 'number' && isFinite(r.total) && r.total > 0 && r.total < 100000 ? Math.round(r.total * 100) / 100 : null;
  let date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && !isNaN(Date.parse(r.date)) &&
    r.date <= todayIso && r.date >= '2000-01-01' ? r.date : null;
  const clip = (s: any, n: number) => typeof s === 'string' && s.trim() ? s.replace(/\s+/g, ' ').trim().slice(0, n) : null;
  const store = clip(r.store, 80), summary = clip(r.summary, 60);
  const category = CATEGORIES.includes(r.category) ? r.category : 'other';
  const description = store && summary ? `${store} – ${summary}` : store || summary;
  return { found: true, amount, date, description, category };
}

// Best effort: tell the database how this reading ended (for the owner's counts). Never blocks the answer.
async function finish(fetchFn: typeof fetch, url: string, svc: string, user: string, outcome: string) {
  try {
    await fetchFn(url + '/rest/v1/rpc/finish_receipt_scan', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + svc, apikey: svc, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user: user, p_outcome: outcome })
    });
  } catch { /* stats only */ }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

export async function handle(req: Request, env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'bad_request' }, 405);
  const url = env.SUPABASE_URL, svc = env.SUPABASE_SERVICE_ROLE_KEY, key = env.ANTHROPIC_API_KEY;
  if (!url || !svc || !key) return json({ error: 'not_set_up' }, 503);

  // 1. Who is asking? (must be a signed-in SiblingTab user)
  const auth = req.headers.get('Authorization') || '';
  const who = await fetchFn(url + '/auth/v1/user', { headers: { Authorization: auth, apikey: svc } });
  if (!who.ok) return json({ error: 'not_signed_in' }, 401);
  const user = await who.json();
  if (!user || !user.id) return json({ error: 'not_signed_in' }, 401);

  // 2. Is it a sensible image?
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const image = body && body.image, type = body && body.media_type;
  if (typeof image !== 'string' || !MEDIA.includes(type) || image.length > MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return json({ error: 'bad_image' }, 400);
  }

  // 3. Daily limits (per person, and for everyone together)
  const userLimit = parseInt(env.RECEIPT_USER_DAILY || '15', 10), globalLimit = parseInt(env.RECEIPT_GLOBAL_DAILY || '300', 10);
  const claim = await fetchFn(url + '/rest/v1/rpc/claim_receipt_scan', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + svc, apikey: svc, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_user: user.id, p_user_limit: userLimit, p_global_limit: globalLimit })
  });
  if (!claim.ok) return json({ error: 'unavailable' }, 502);
  const verdict = await claim.json();
  if (verdict === 'user_limit') return json({ error: 'daily_limit' }, 429);
  if (verdict !== 'ok') return json({ error: 'busy' }, 429);

  // 4. Ask Claude to read it (small output, forced structured answer)
  let res: Response;
  try {
    res = await fetchFn('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.RECEIPT_MODEL || 'claude-sonnet-5-5',
        max_tokens: 300,
        tools: [TOOL],
        tool_choice: { type: 'tool', name: 'record_receipt' },
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: type, data: image } },
          { type: 'text', text: PROMPT }
        ] }]
      })
    });
  } catch { await finish(fetchFn, url, svc, user.id, 'error'); return json({ error: 'unavailable' }, 502); }
  if (!res.ok) { await finish(fetchFn, url, svc, user.id, 'error'); return json({ error: 'unavailable' }, 502); }
  const out = await res.json();
  const block = Array.isArray(out.content) ? out.content.find((b: any) => b.type === 'tool_use') : null;
  if (!block) { await finish(fetchFn, url, svc, user.id, 'unreadable'); return json({ error: 'unreadable' }, 422); }

  const today = new Date().toISOString().slice(0, 10);
  const result = cleanResult(block.input, today);
  await finish(fetchFn, url, svc, user.id, result.found ? 'read' : 'not_receipt');
  return json(result);
}

// @ts-ignore: Deno is provided by Supabase when the function runs
if (typeof Deno !== 'undefined') Deno.serve((req: Request) => handle(req, Deno.env.toObject()));
