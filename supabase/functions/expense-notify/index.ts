// SiblingTab "new expense" email. Runs as a Supabase Edge Function ("expense-notify").
// The app calls it right after someone adds an expense. It emails the OTHER family members who
// switched on "Email me when someone in my family adds an expense" (Account page, off by default).
//
// Secrets (Edge Functions -> Secrets): the same SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS the
// monthly-summary function uses (the noreply@siblingtab.com mailbox). Supabase fills in
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY by itself. Leave "Verify JWT" ON.

const APP_URL = 'https://app.siblingtab.com/';
const FROM = '"SiblingTab" <noreply@siblingtab.com>';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const CATEGORY: Record<string, string> = {
  medication: 'Medication & pharmacy', medical: 'Medical & dental', care_home: 'Care home / residence',
  home_care: 'Home care & help', transport: 'Transport & parking', groceries: 'Groceries & meals',
  home: 'Home & repairs', equipment: 'Equipment & supplies', other: 'Other'
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

export function money(cents: number) {
  const abs = Math.abs(Math.round(cents));
  return (cents < 0 ? '-' : '') + '$' + Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') +
    '.' + String(abs % 100).padStart(2, '0');
}
export function esc(s: unknown) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]);
}
function dayLabel(iso: string) {
  const [, m, d] = String(iso).split('-').map(Number);
  return MONTHS[m - 1] ? MONTHS[m - 1].slice(0, 3) + ' ' + d : String(iso);
}

// One email for one recipient. Plain facts only: who added what. Nothing about balances or who owes whom.
export function buildEmail(p: any, r: { email: string; unsub_token: string }) {
  const unsubUrl = APP_URL + '#/unsubscribe-expenses/' + r.unsub_token;
  const who = p.actor_name || 'Someone in your family';
  const cat = CATEGORY[p.category] || 'Expense';
  const what = String(p.description || '').trim();
  const line = who + ' added a new expense to ' + p.family_name + '.';
  const facts: [string, string][] = [['Amount', money(Number(p.amount_cents))], ['Date', dayLabel(p.spent_on)], ['Category', cat]];
  if (what) facts.push(['For', what]);
  const text = [line, '', ...facts.map(([k, v]) => k + ': ' + v), '', 'Open SiblingTab: ' + APP_URL, '', '--',
    'You get this because you turned on new expense emails in SiblingTab (Account page).',
    'Stop these emails: ' + unsubUrl, 'Questions: hello@siblingtab.com'].join('\n');
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;max-width:560px;margin:0 auto;padding:16px">' +
    '<p style="margin:0 0 16px">' + esc(line) + '</p>' +
    '<ul style="margin:0 0 16px;padding-left:20px">' + facts.map(([k, v]) => '<li><b>' + k + ':</b> ' + esc(v) + '</li>').join('') + '</ul>' +
    '<p style="margin:20px 0"><a href="' + APP_URL + '" style="background:#1f5c57;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Open SiblingTab</a></p>' +
    '<hr style="border:0;border-top:1px solid #ddd;margin:24px 0 12px">' +
    '<p style="font-size:13px;color:#666;margin:0 0 6px">You get this because you turned on new expense emails in SiblingTab (Account page).</p>' +
    '<p style="font-size:13px;color:#666;margin:0"><a href="' + unsubUrl + '" style="color:#666">Stop these emails</a> · Questions: <a href="mailto:hello@siblingtab.com" style="color:#666">hello@siblingtab.com</a></p></div>';
  return { to: r.email, subject: who + ' added an expense in SiblingTab', text, html, unsubUrl };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

type Mailer = (m: { from: string; to: string; subject: string; text: string; html: string; headers: Record<string, string> }) => Promise<unknown>;

async function smtpMailer(env: Record<string, string | undefined>): Promise<Mailer> {
  const nodemailer = (await import('npm:nodemailer@6.9.16')).default;
  const port = Number(env.SMTP_PORT || 465);
  const t = nodemailer.createTransport({ host: env.SMTP_HOST, port, secure: port === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
  return (m) => t.sendMail(m);
}

export async function handle(req: Request, env: Record<string, string | undefined>,
  fetchFn: typeof fetch = fetch, mailer?: Mailer): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'bad_request' }, 405);
  const url = env.SUPABASE_URL, svc = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) return json({ error: 'not_set_up' }, 503);

  // 1. Who is asking? (a signed-in SiblingTab user)
  const who = await fetchFn(url + '/auth/v1/user', { headers: { Authorization: req.headers.get('Authorization') || '', apikey: svc } });
  if (!who.ok) return json({ error: 'not_signed_in' }, 401);
  const user = await who.json();
  if (!user || !user.id) return json({ error: 'not_signed_in' }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const id = body && body.expense_id;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return json({ error: 'bad_request' }, 400);

  // 2. The database decides: only the person who just added this expense, only once, only to opted-in family members.
  const res = await fetchFn(url + '/rest/v1/rpc/expense_alert_payload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + svc, apikey: svc, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_expense: id, p_actor: user.id })
  });
  if (!res.ok) return json({ error: 'unavailable' }, 502);
  const payload = await res.json();
  if (!payload || !payload.recipients || !payload.recipients.length) return json({ sent: 0 });

  // 3. Send one email per person (each has their own unsubscribe link).
  let send: Mailer;
  try { send = mailer || await smtpMailer(env); } catch (e) { console.error('mail setup failed:', String(e)); return json({ error: 'unavailable' }, 502); }
  let sent = 0, failed = 0;
  for (const r of payload.recipients) {
    const e = buildEmail(payload, r);
    try {
      await send({ from: FROM, to: e.to, subject: e.subject, text: e.text, html: e.html, headers: { 'List-Unsubscribe': '<' + e.unsubUrl + '>' } });
      sent++;
    } catch (err) { failed++; console.error('send failed:', String((err as any)?.message || err)); }
  }
  return json({ sent, failed });
}

if (typeof Deno !== 'undefined' && (Deno as any).serve) (Deno as any).serve((req: Request) => handle(req, (Deno as any).env.toObject()));
