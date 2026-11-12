// Click-through test using the fake Supabase. Serve app/ on http://localhost:8765, then: node tests/e2e-playwright.js [screenshot-dir]
// Needs tests/receipt.png (any image).
const { chromium } = require('playwright');
const fs = require('fs');

const MOCK = fs.readFileSync(require('path').join(__dirname, 'mock-supabase.js'), 'utf8');
const SHOTS = process.argv[2];
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith('/vendor/supabase-2.118.0.js')) return route.fulfill({ body: MOCK, contentType: 'text/javascript' });
    if (u.pathname.endsWith('/config.js')) return route.fulfill({ body: "window.SIBLINGTAB_CONFIG={supabaseUrl:'https://x.supabase.co',supabaseAnonKey:'k'}", contentType: 'text/javascript' });
    return route.continue();
  });
  const base = 'http://localhost:8765/';
  let n = 0; const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${String(++n).padStart(2,'0')}-${name}.png`, fullPage: true });
  const step = s => console.log('✓', s);

  await page.goto(base);
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor(); await shot('login');
  await page.getByText('New here? Create an account').click(); await page.getByRole('heading', { name: 'Create your account' }).waitFor();
  await page.getByLabel('Email').fill('marc@example.com');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Set up your family space' }).waitFor(); await shot('setup');
  step('sign up');
  await page.getByLabel('Name for this family space').fill('Mom’s care');
  await page.getByLabel('Your name, as your siblings know you').fill('Marc');
  await page.getByRole('button', { name: 'Create family space' }).click();
  await page.getByRole('heading', { name: 'Invite a sibling' }).waitFor();
  await page.getByRole('button', { name: 'Get an invite link' }).click();
  const link = await page.locator('.invite input').inputValue(); await shot('family-invite');
  if (!/#\/join\/[0-9a-f]{32}$/.test(link)) throw new Error('bad link ' + link);
  step('family created, invite link ' + link.slice(-40));

  // Marc logs a solo expense first
  await page.getByRole('link', { name: 'Expenses' }).click();
  await page.getByText('No expenses yet.').waitFor(); await shot('empty');
  await page.getByRole('link', { name: '+ Add an expense' }).click(); await page.getByRole('heading', { name: 'Add an expense' }).waitFor();
  await page.getByLabel('Amount (CAD)').fill('30');
  await page.getByLabel('What was it for?').fill('Hospital parking');
  await page.getByLabel('Category').selectOption('transport');
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByText('Hospital parking').waitFor();
  step('Marc adds an expense');

  await page.getByRole('link', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();

  // Sibling follows invite link
  await page.goto(link);
  await page.getByText('You’ve been invited to a family').waitFor(); await shot('invited-login');
  await page.getByText('New here? Create an account').click(); await page.getByRole('heading', { name: 'Create your account' }).waitFor();
  await page.getByLabel('Email').fill('julie@example.com');
  await page.getByLabel('Password').fill('password456');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Join “Mom’s care”' }).waitFor(); await shot('join');
  await page.getByLabel('Your name, as your siblings know you').fill('Julie');
  await page.getByRole('button', { name: 'Join family' }).click();
  await page.getByText('Hospital parking').waitFor();
  step('sibling signs up via invite and joins');

  // Julie adds a pharmacy expense with a receipt, split between both
  await page.getByRole('link', { name: '+ Add an expense' }).click(); await page.getByRole('heading', { name: 'Add an expense' }).waitFor();
  const boxes = page.locator('fieldset .check input'); if (await boxes.count() !== 2) throw new Error('expected 2 members');
  await page.getByLabel('Amount (CAD)').fill('$90.01');
  await page.getByLabel('What was it for?').fill('Shoppers – prescriptions');
  await page.getByText('Split evenly').waitFor();
  await page.locator('input[type=file]').setInputFiles(require('path').join(__dirname, 'receipt.png')); await shot('add-expense');
  await page.getByRole('button', { name: 'Add expense' }).click();
  await page.getByText('Shoppers – prescriptions').waitFor({ timeout: 5000 }).catch(async e => { console.log('TOAST:', await page.locator('#toast').innerText(), '| H1:', await page.locator('h1').first().innerText(), errors); throw e; }); await shot('expenses');
  step('sibling adds expense with receipt photo');

  await page.getByText('Shoppers – prescriptions').click();
  await page.locator('.receipt img').waitFor(); await shot('detail');
  const split = await page.locator('.facts').innerText();
  if (!split.includes('$45.01') || !split.includes('$45.00')) throw new Error('split wrong: ' + split);
  step('receipt shows, split 45.01 / 45.00');

  await page.getByRole('link', { name: '‹ All expenses' }).click();
  await page.getByRole('link', { name: 'Who owes' }).click();
  // Marc paid 30 (only his share), Julie paid 90.01 split → Marc owes Julie 45.00
  await page.locator('li.owe').waitFor(); await shot('balances');
  const owe = await page.locator('li.owe').innerText();
  if (!/Marc owes Julie \(you\)\s*\$45\.01/.test(owe.replace(/\n/g, ' '))) throw new Error('owe wrong: ' + owe);
  step('who owes whom: ' + owe.replace(/\s+/g, ' '));
  await page.getByRole('button', { name: 'Mark paid' }).click();
  await page.getByLabel('Amount (CAD)').fill('20');
  await page.getByLabel('Note (optional)').fill('e-Transfer');
  await page.getByRole('button', { name: 'Record payment' }).click();
  await page.getByText('Payments between siblings').waitFor(); await shot('after-payment');
  const owe2 = await page.locator('li.owe').innerText();
  if (!owe2.includes("$25.01")) throw new Error('after payment wrong: ' + owe2);
  step('partial payment recorded, now owes $25.01');

  await page.getByRole('link', { name: 'Export' }).click(); await shot('export');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download spreadsheet' }).click()]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  console.log('   CSV file:', dl.suggestedFilename()); console.log(csv.split('\r\n').map(l => '   ' + l).join('\n'));
  step('CSV export');

  // Marc can see but not edit Julie's expense
  await page.getByRole('link', { name: 'Account' }).click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await page.getByRole('heading', { name: 'Welcome back' }).waitFor();
  await page.getByLabel('Email').fill('marc@example.com');
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Log in' }).click();
   await page.getByText('don’t match').waitFor();
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.getByText('Shoppers – prescriptions').click();
  await page.getByText('Only Julie can edit').waitFor();
  step('wrong password message; Marc sees sibling expense read-only');
  await page.goBack();
  await page.getByText('Hospital parking').click();
  await page.getByRole('link', { name: 'Edit' }).click();
  await page.getByLabel('Amount (CAD)').fill('31.50');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('heading', { name: '$31.50' }).waitFor();
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Tap again to delete' }).click();
  await page.getByText('Expense deleted').waitFor(); await page.getByRole('link', { name: '+ Add an expense' }).waitFor();
  if (await page.getByText('Hospital parking').count()) throw new Error('not deleted');
  step('edit and delete own expense');

  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto(base + '#/f/x'); await page.waitForTimeout(300); await shot('bad-family');
  console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no page errors');
  await browser.close();
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
