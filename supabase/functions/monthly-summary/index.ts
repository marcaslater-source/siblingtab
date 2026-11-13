// SiblingTab monthly summary email. Runs as a Supabase Edge Function, started by the
// monthly schedule (see migrations/006). Written in plain JavaScript so it can also be tested in Node.
//
// Settings it needs (Edge Functions -> monthly-summary -> Secrets):
//   CRON_SECRET  a long random string; the schedule sends it so nobody else can trigger the job
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS   the same noreply@siblingtab.com mailbox
//                Supabase uses for sign-up emails
// Supabase fills in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY by itself.

const APP_URL = 'https://app.siblingtab.com/';
const FROM = '"SiblingTab" <noreply@siblingtab.com>';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const CATEGORY = {
  medication: 'Medication & pharmacy', medical: 'Medical & dental', care_home: 'Care home / residence',
  home_care: 'Home care & help', transport: 'Transport & parking', groceries: 'Groceries & meals',
  home: 'Home & repairs', equipment: 'Equipment & supplies', other: 'Other'
};

export function money(cents) {
  const abs = Math.abs(Math.round(cents));
  const d = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (cents < 0 ? '-' : '') + '$' + d + '.' + String(abs % 100).padStart(2, '0');
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Same "A pays B" logic as the app's Balances screen.
export function whoOwesWhom(net) {
  const debtors = [], creditors = [];
  Object.keys(net).forEach((id) => {
    if (net[id] < 0) debtors.push({ id, amt: -net[id] });
    else if (net[id] > 0) creditors.push({ id, amt: net[id] });
  });
  const byAmt = (a, b) => b.amt - a.amt || (a.id < b.id ? -1 : 1);
  debtors.sort(byAmt); creditors.sort(byAmt);
  const out = []; let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    if (pay > 0) out.push({ from: debtors[i].id, to: creditors[j].id, amount_cents: pay });
    debtors[i].amt -= pay; creditors[j].amt -= pay;
    if (debtors[i].amt === 0) i++;
    if (creditors[j].amt === 0) j++;
  }
  return out;
}

// "2026-10-01" -> { start: '2026-10-01', end: '2026-11-01', label: 'October 2026' }
export function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const p = (n) => String(n).padStart(2, '0');
  return { start: y + '-' + p(m) + '-01', end: ny + '-' + p(nm) + '-01', label: MONTHS[m - 1] + ' ' + y };
}

// The month before "now", by the calendar in Toronto.
export function previousMonth(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit' })
    .formatToParts(now);
  let y = Number(parts.find((x) => x.type === 'year').value);
  let m = Number(parts.find((x) => x.type === 'month').value) - 1;
  if (m === 0) { m = 12; y -= 1; }
  return y + '-' + String(m).padStart(2, '0');
}

function dayLabel(iso) {
  const [, m, d] = String(iso).split('-').map(Number);
  return MONTHS[m - 1].slice(0, 3) + ' ' + d;
}

// Turn one family's numbers into plain facts. Nothing here ranks or compares siblings.
function familyFacts(f, month) {
  const names = {};
  f.members.forEach((m) => { names[m.id] = m.name; });
  const nm = (id) => names[id] || 'Former member';
  // Alphabetical, so nobody is listed first or last for paying more or less.
  const paid = f.members.filter((m) => Number(f.paid[m.id] || 0) > 0)
    .map((m) => ({ name: m.name, cents: Number(f.paid[m.id]) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const net = {};
  Object.keys(f.net).forEach((k) => { net[k] = Number(f.net[k]); });
  const steps = whoOwesWhom(net).map((s) => ({ from: nm(s.from), to: nm(s.to), cents: s.amount_cents }));
  return {
    name: f.name, total: Number(f.total_cents), count: Number(f.expense_count), paid, steps,
    paidBack: Number(f.paid_back_cents), missingCount: Number(f.missing_count),
    missing: f.missing.map((e) => ({
      date: dayLabel(e.spent_on), what: e.description || CATEGORY[e.category] || 'Expense', cents: Number(e.amount_cents)
    })),
    quiet: Number(f.expense_count) === 0 && Number(f.paid_back_cents) === 0 && steps.length === 0
  };
}

// recipient = one item from monthly_summary_payloads. Returns null if there is nothing worth sending.
export function buildEmail(recipient, month) {
  const { label } = monthRange(month);
  const unsubUrl = APP_URL + '#/unsubscribe/' + recipient.unsub_token;
  const facts = recipient.families.map((f) => familyFacts(f, month)).filter((f) => !f.quiet);
  if (!facts.length) return null;

  const t = [], h = [];
  const hello = 'Hi ' + (recipient.families.length === 1 && recipient.name ? recipient.name : 'there') + ',';
  t.push(hello, '', 'Here is a quick look at your family’s caregiving costs for ' + label + '.', '');
  h.push('<p style="margin:0 0 16px">' + esc(hello) + '</p>',
    '<p style="margin:0 0 16px">Here is a quick look at your family’s caregiving costs for ' + esc(label) + '.</p>');

  facts.forEach((f) => {
    const multi = facts.length > 1;
    if (multi) { t.push('== ' + f.name + ' =='); h.push('<h2 style="font-size:18px;margin:24px 0 8px">' + esc(f.name) + '</h2>'); }
    else { h.push('<h2 style="font-size:18px;margin:24px 0 8px">' + esc(f.name) + '</h2>'); t.push(f.name.toUpperCase()); }

    t.push('Costs this month: ' + money(f.total) + ' across ' + f.count + (f.count === 1 ? ' expense' : ' expenses'));
    h.push('<p style="margin:0 0 8px"><b>Costs this month:</b> ' + money(f.total) + ' across ' + f.count +
      (f.count === 1 ? ' expense' : ' expenses') + '</p>');

    if (f.paid.length) {
      t.push('Who covered what:');
      h.push('<p style="margin:0 0 4px"><b>Who covered what</b></p><ul style="margin:0 0 12px;padding-left:20px">');
      f.paid.forEach((p) => { t.push('  - ' + p.name + ': ' + money(p.cents)); h.push('<li>' + esc(p.name) + ': ' + money(p.cents) + '</li>'); });
      h.push('</ul>');
    }
    if (f.paidBack > 0) {
      t.push('Paid back between family this month: ' + money(f.paidBack));
      h.push('<p style="margin:0 0 12px"><b>Paid back between family this month:</b> ' + money(f.paidBack) + '</p>');
    }

    t.push('Where things stand:');
    h.push('<p style="margin:0 0 4px"><b>Where things stand</b></p>');
    if (!f.steps.length) {
      t.push('  Everyone is even. Nothing to settle.');
      h.push('<p style="margin:0 0 12px">Everyone is even. Nothing to settle.</p>');
    } else {
      t.push('  One simple way to even things out:');
      h.push('<p style="margin:0 0 4px">One simple way to even things out:</p><ul style="margin:0 0 12px;padding-left:20px">');
      f.steps.forEach((s) => {
        t.push('  - ' + s.from + ' sends ' + s.to + ' ' + money(s.cents));
        h.push('<li>' + esc(s.from) + ' sends ' + esc(s.to) + ' ' + money(s.cents) + '</li>');
      });
      h.push('</ul>');
    }

    if (f.missingCount > 0) {
      const n = f.missingCount;
      t.push('Receipts to add: ' + n + (n === 1 ? ' expense has' : ' expenses have') +
        ' no receipt photo yet. Adding them now makes tax time easier.');
      h.push('<p style="margin:0 0 4px"><b>Receipts to add:</b> ' + n + (n === 1 ? ' expense has' : ' expenses have') +
        ' no receipt photo yet. Adding them now makes tax time easier.</p><ul style="margin:0 0 12px;padding-left:20px">');
      f.missing.forEach((e) => {
        t.push('  - ' + e.date + ': ' + e.what + ' (' + money(e.cents) + ')');
        h.push('<li>' + esc(e.date) + ': ' + esc(e.what) + ' (' + money(e.cents) + ')</li>');
      });
      if (n > f.missing.length) {
        t.push('  ...and ' + (n - f.missing.length) + ' more');
        h.push('<li>…and ' + (n - f.missing.length) + ' more</li>');
      }
      h.push('</ul>');
    }
    t.push('');
  });

  t.push('Open SiblingTab: ' + APP_URL, '', '--',
    'You get this once a month because you turned on monthly summaries in SiblingTab (Account page).',
    'Stop these emails: ' + unsubUrl, 'Questions: hello@siblingtab.com');
  h.push('<p style="margin:20px 0"><a href="' + APP_URL + '" style="background:#1f5c57;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Open SiblingTab</a></p>',
    '<hr style="border:0;border-top:1px solid #ddd;margin:24px 0 12px">',
    '<p style="font-size:13px;color:#666;margin:0 0 6px">You get this once a month because you turned on monthly summaries in SiblingTab (Account page).</p>',
    '<p style="font-size:13px;color:#666;margin:0"><a href="' + unsubUrl + '" style="color:#666">Stop these emails</a> · Questions: <a href="mailto:hello@siblingtab.com" style="color:#666">hello@siblingtab.com</a></p>');

  return {
    to: recipient.email,
    subject: 'Your SiblingTab summary for ' + label,
    text: t.join('\n'),
    html: '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;max-width:560px;margin:0 auto;padding:16px">' + h.join('\n') + '</div>',
    unsubUrl
  };
}

async function handle(req) {
  const env = (k) => Deno.env.get(k);
  const json = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2),
    { status, headers: { 'Content-Type': 'application/json' } });

  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const secret = env('CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'Not allowed' }, 401);

  let body = {};
  try { body = await req.json(); } catch (_) { /* empty body is fine */ }
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(body.month || '') ? body.month : previousMonth();
  const { start, end } = monthRange(month);
  const dryRun = body.dry_run === true;
  const onlyEmail = typeof body.only_email === 'string' ? body.only_email : null;

  const { createClient } = await import('npm:@supabase/supabase-js@2.118.0');
  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
  const { data, error } = await sb.rpc('monthly_summary_payloads', { p_start: start, p_end: end, p_only_email: onlyEmail });
  if (error) return json({ error: error.message }, 500);

  const emails = [];
  const recipients = [];
  for (const r of data) {
    const e = buildEmail(r, month);
    if (e) { emails.push(e); recipients.push(r); }
  }

  // Dry run: show exactly what would be sent, send nothing, record nothing.
  if (dryRun) return json({ dry_run: true, month, would_send: emails.length, emails });

  let transport = null;
  if (emails.length) {
    const nodemailer = (await import('npm:nodemailer@6.9.16')).default;
    const port = Number(env('SMTP_PORT') || 465);
    transport = nodemailer.createTransport({
      host: env('SMTP_HOST'), port, secure: port === 465,
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') }
    });
  }
  let sent = 0; const failed = [];
  for (let i = 0; i < emails.length; i++) {
    const e = emails[i];
    try {
      await transport.sendMail({
        from: FROM, to: e.to, subject: e.subject, text: e.text, html: e.html,
        headers: { 'List-Unsubscribe': '<' + e.unsubUrl + '>' }
      });
      const { error: logErr } = await sb.rpc('mark_summary_sent', { p_user: recipients[i].user_id, p_start: start });
      if (logErr) failed.push({ user_id: recipients[i].user_id, step: 'log', error: logErr.message });
      sent++;
    } catch (err) {
      failed.push({ user_id: recipients[i].user_id, step: 'send', error: String(err && err.message || err) });
    }
  }
  return json({ month, sent, failed });
}

if (typeof Deno !== 'undefined' && Deno.serve) Deno.serve(handle);
