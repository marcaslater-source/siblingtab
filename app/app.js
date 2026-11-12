// SiblingTab web app. Plain JavaScript, no build step: upload the folder and it runs.
(function () {
  'use strict';

  var L = window.STLogic;
  var cfg = window.SIBLINGTAB_CONFIG || {};
  var appEl = document.getElementById('app');
  var topRight = document.getElementById('topbar-right');
  var PENDING_INVITE = 'siblingtab.pendingInvite';

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  // Build DOM safely. Text is always set as text, never as HTML.
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'required') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) return c.forEach(function (x) { append(el, x); });
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  function render() {
    appEl.replaceChildren();
    for (var i = 0; i < arguments.length; i++) append(appEl, arguments[i]);
    window.scrollTo(0, 0);
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  var toastTimer;
  function toast(msg, isError) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = isError ? 'error' : '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 6000 : 3000);
  }
  function friendlyError(err) {
    var m = (err && (err.message || err.error_description)) || String(err || 'Something went wrong');
    if (/Invalid login credentials/i.test(m)) return 'That email and password don’t match. Try again or reset your password.';
    if (/Email not confirmed/i.test(m)) return 'Please confirm your email first. Check your inbox for the link we sent.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Can’t reach SiblingTab. Check your internet connection.';
    return m;
  }
  function todayIso() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function niceDate(iso) {
    var p = String(iso).split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  function busy(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Working…'; btn.disabled = true; }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
  }
  function field(label, input, hint) {
    return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
  }

  // ---------------------------------------------------------------------------
  // Setup check and Supabase client
  // ---------------------------------------------------------------------------

  if (!cfg.supabaseUrl || /YOUR-PROJECT/.test(cfg.supabaseUrl) || !cfg.supabaseAnonKey || /YOUR-/.test(cfg.supabaseAnonKey)) {
    render(h('section', { class: 'card narrow' },
      h('h1', null, 'Almost there'),
      h('p', null, 'SiblingTab isn’t connected to its database yet. Open config.js and paste in your Supabase project URL and public key (see SETUP.md, step 3).')));
    return;
  }

  var sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  var state = {
    session: null,
    recovering: false,     // came back from a "reset password" email
    families: null,        // [{family_id, display_name, role, families:{name}}]
    fam: null              // data for the open family
  };

  function me() { return state.session && state.session.user; }
  function appUrl() { return location.origin + location.pathname; }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  function must(res) { if (res.error) throw res.error; return res.data; }

  async function loadFamilies() {
    state.families = must(await sb.from('family_members')
      .select('family_id, display_name, role, families(name)')
      .eq('user_id', me().id)
      .order('joined_at'));
    return state.families;
  }

  async function loadFamily(fid) {
    var results = await Promise.all([
      sb.from('families').select('id, name').eq('id', fid).maybeSingle(),
      sb.from('family_members').select('user_id, display_name, role, joined_at').eq('family_id', fid).order('joined_at'),
      sb.from('expenses').select('*').eq('family_id', fid).order('spent_on', { ascending: false }).order('created_at', { ascending: false }),
      sb.from('expense_shares').select('expense_id, user_id, share_cents').eq('family_id', fid),
      sb.from('settlements').select('*').eq('family_id', fid).order('settled_on', { ascending: false }).order('created_at', { ascending: false })
    ]);
    var family = must(results[0]);
    if (!family) throw new Error('You’re not a member of that family, or it no longer exists.');
    state.fam = {
      id: fid, name: family.name, members: must(results[1]), expenses: must(results[2]),
      shares: must(results[3]), settlements: must(results[4])
    };
    lsSet('siblingtab.lastFamily', fid);
    return state.fam;
  }

  function nameOf(uid) {
    var m = state.fam && state.fam.members.find(function (x) { return x.user_id === uid; });
    if (!m) return 'Former member';
    return m.user_id === me().id ? m.display_name + ' (you)' : m.display_name;
  }

  // ---------------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------------

  var routeSeq = 0;
  async function route() {
    var seq = ++routeSeq;
    var parts = (location.hash.replace(/^#\/?/, '') || '').split('/').filter(Boolean);
    renderTopbar();

    if (state.recovering) return viewNewPassword();

    if (!me()) {
      if (parts[0] === 'join' && parts[1]) lsSet(PENDING_INVITE, parts[1]);
      return viewAuth(parts[0] === 'signup' ? 'signup' : parts[0] === 'reset' ? 'reset' : 'login');
    }

    try {
      if (parts[0] === 'join' && parts[1]) return await viewJoin(parts[1]);
      var pending = lsGet(PENDING_INVITE);
      if (pending) { lsSet(PENDING_INVITE, null); return go('#/join/' + pending); }

      if (parts[0] === 'new') return viewCreateFamily();
      if (parts[0] === 'account') return viewAccount();

      if (parts[0] === 'f' && parts[1]) {
        var fid = parts[1];
        if (!state.fam || state.fam.id !== fid || parts[2] == null || parts[2] === 'balances') {
          // Always refresh when landing on a family's main tabs, so siblings' new entries show up.
          await loadFamily(fid);
        }
        if (seq !== routeSeq) return;
        var tab = parts[2] || 'expenses';
        if (tab === 'expenses') return viewExpenses();
        if (tab === 'add') return viewExpenseForm(null);
        if (tab === 'e' && parts[3]) return viewExpenseDetail(parts[3]);
        if (tab === 'edit' && parts[3]) return viewExpenseForm(parts[3]);
        if (tab === 'balances') return viewBalances();
        if (tab === 'family') return viewFamily();
        if (tab === 'export') return viewExport();
      }

      // Home: open the family you used last, or the only one, or show the list.
      var fams = await loadFamilies();
      if (seq !== routeSeq) return;
      if (!fams.length) return viewCreateFamily(true);
      var last = lsGet('siblingtab.lastFamily');
      var pick = fams.find(function (f) { return f.family_id === last; }) || (fams.length === 1 ? fams[0] : null);
      if (pick && parts[0] !== 'families') return go('#/f/' + pick.family_id);
      return viewFamilyList(fams);
    } catch (err) {
      if (seq !== routeSeq) return;
      render(h('section', { class: 'card narrow' },
        h('h1', null, 'Something went wrong'),
        h('p', null, friendlyError(err)),
        h('p', null, h('a', { class: 'btn', href: '#/families' }, 'Back to my families'))));
    }
  }

  function renderTopbar() {
    topRight.replaceChildren();
    if (me() && !state.recovering) {
      append(topRight, h('a', { class: 'link', href: '#/account', title: 'Your account' }, 'Account'));
    }
  }

  // ---------------------------------------------------------------------------
  // Sign in / sign up / reset password
  // ---------------------------------------------------------------------------

  function viewAuth(mode) {
    var pendingInvite = lsGet(PENDING_INVITE);
    var email = h('input', { type: 'email', autocomplete: 'email', required: true, inputmode: 'email' });
    var pass = h('input', { type: 'password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', required: true, minlength: mode === 'signup' ? '8' : null });
    var btn = h('button', { class: 'btn primary', type: 'submit' },
      mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Log in');

    var form = h('form', {
      class: 'stack', onsubmit: async function (ev) {
        ev.preventDefault();
        busy(btn, true);
        try {
          if (mode === 'login') {
            must(await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value }));
          } else if (mode === 'signup') {
            var data = must(await sb.auth.signUp({
              email: email.value.trim(), password: pass.value,
              options: { emailRedirectTo: appUrl() }
            }));
            if (!data.session) {
              render(h('section', { class: 'card narrow' },
                h('h1', null, 'Check your email'),
                h('p', null, 'We sent a confirmation link to ', h('strong', null, email.value.trim()),
                  '. Open it on this device to finish creating your account.'),
                h('p', { class: 'muted' }, 'Can’t find it? Check your spam or promotions folder.')));
            }
          } else {
            must(await sb.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: appUrl() }));
            render(h('section', { class: 'card narrow' },
              h('h1', null, 'Check your email'),
              h('p', null, 'If there’s an account for that address, we’ve sent a link to choose a new password.')));
          }
        } catch (err) {
          toast(friendlyError(err), true);
        } finally { busy(btn, false); }
      }
    },
      field('Email', email),
      mode !== 'reset' ? field('Password', pass, mode === 'signup' ? 'At least 8 characters.' : null) : null,
      btn);

    var links = mode === 'login'
      ? [h('a', { href: '#/signup' }, 'New here? Create an account'), h('a', { href: '#/reset' }, 'Forgot your password?')]
      : [h('a', { href: '#/login' }, 'Already have an account? Log in')];

    render(h('section', { class: 'card narrow' },
      h('h1', null, mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Welcome back'),
      pendingInvite ? h('p', { class: 'note' }, 'You’ve been invited to a family on SiblingTab. Log in or create an account to join.') : null,
      mode === 'signup' ? h('p', { class: 'muted' }, 'One account per person. Each sibling makes their own and joins the family with an invite link.') : null,
      form,
      h('p', { class: 'links' }, links),
      h('p', { class: 'muted small' }, 'Your family’s information is stored in Canada and only members of your family can see it.')));
  }

  function viewNewPassword() {
    var pass = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: '8' });
    var btn = h('button', { class: 'btn primary', type: 'submit' }, 'Save new password');
    render(h('section', { class: 'card narrow' },
      h('h1', null, 'Choose a new password'),
      h('form', {
        class: 'stack', onsubmit: async function (ev) {
          ev.preventDefault(); busy(btn, true);
          try {
            must(await sb.auth.updateUser({ password: pass.value }));
            state.recovering = false;
            toast('Password updated');
            go('#/');
          } catch (err) { toast(friendlyError(err), true); } finally { busy(btn, false); }
        }
      }, field('New password', pass, 'At least 8 characters.'), btn)));
  }

  // ---------------------------------------------------------------------------
  // Families
  // ---------------------------------------------------------------------------

  function viewFamilyList(fams) {
    render(h('section', { class: 'card narrow' },
      h('h1', null, 'Your families'),
      h('ul', { class: 'list' }, fams.map(function (f) {
        return h('li', null, h('a', { class: 'row-link', href: '#/f/' + f.family_id },
          h('strong', null, f.families ? f.families.name : 'Family'), h('span', { class: 'muted' }, '›')));
      })),
      h('p', null, h('a', { class: 'btn', href: '#/new' }, '+ Start another family space'))));
  }

  function viewCreateFamily(first) {
    var famName = h('input', { type: 'text', required: true, maxlength: '80', placeholder: 'e.g. Mom’s care' });
    var myName = h('input', { type: 'text', required: true, maxlength: '60', autocomplete: 'given-name', placeholder: 'e.g. Marc' });
    var btn = h('button', { class: 'btn primary', type: 'submit' }, 'Create family space');
    render(h('section', { class: 'card narrow' },
      h('h1', null, first ? 'Set up your family space' : 'Start a family space'),
      first ? h('p', null, 'A family space is where you and your siblings share expenses for one parent’s care. You’ll invite your siblings next.') : null,
      first ? h('p', { class: 'muted small' }, 'Did a sibling already set one up? Ask them for the invite link instead.') : null,
      h('form', {
        class: 'stack', onsubmit: async function (ev) {
          ev.preventDefault(); busy(btn, true);
          try {
            var fid = must(await sb.rpc('create_family', { family_name: famName.value, my_name: myName.value }));
            toast('Family space created');
            go('#/f/' + fid + '/family');
          } catch (err) { toast(friendlyError(err), true); } finally { busy(btn, false); }
        }
      }, field('Name for this family space', famName), field('Your name, as your siblings know you', myName), btn)));
  }

  async function viewJoin(code) {
    var info = must(await sb.rpc('invite_info', { invite_code: code }));
    var row = info && info[0];
    if (!row || row.expired) {
      return render(h('section', { class: 'card narrow' },
        h('h1', null, 'This invite link doesn’t work'),
        h('p', null, row ? 'It has expired. Ask your sibling to send a new one from the Family tab.' : 'It may have been mistyped. Ask your sibling to send it again.'),
        h('p', null, h('a', { class: 'btn', href: '#/' }, 'Go to SiblingTab'))));
    }
    var myName = h('input', { type: 'text', required: true, maxlength: '60', autocomplete: 'given-name' });
    var btn = h('button', { class: 'btn primary', type: 'submit' }, 'Join family');
    render(h('section', { class: 'card narrow' },
      h('h1', null, 'Join “', row.family_name, '”'),
      h('p', null, 'You’ll be able to see and add shared care expenses for this family.'),
      h('form', {
        class: 'stack', onsubmit: async function (ev) {
          ev.preventDefault(); busy(btn, true);
          try {
            var fid = must(await sb.rpc('join_family', { invite_code: code, my_name: myName.value }));
            toast('You’ve joined ' + row.family_name);
            go('#/f/' + fid);
          } catch (err) { toast(friendlyError(err), true); } finally { busy(btn, false); }
        }
      }, field('Your name, as your siblings know you', myName), btn)));
  }

  // Header + tabs shown on every family screen.
  function famHeader(active) {
    var f = state.fam;
    var tabs = [['expenses', 'Expenses'], ['balances', 'Who owes'], ['family', 'Family'], ['export', 'Export']];
    return [
      h('div', { class: 'fam-head' },
        h('h1', null, f.name),
        h('a', { class: 'link small', href: '#/families' }, 'Switch')),
      h('nav', { class: 'tabs' }, tabs.map(function (t) {
        return h('a', { href: '#/f/' + f.id + '/' + t[0], class: active === t[0] ? 'active' : null,
          'aria-current': active === t[0] ? 'page' : null }, t[1]);
      }))
    ];
  }

  // ---------------------------------------------------------------------------
  // Expenses
  // ---------------------------------------------------------------------------

  function viewExpenses() {
    var f = state.fam;
    var total = f.expenses.reduce(function (s, e) { return s + e.amount_cents; }, 0);
    var net = L.netBalances(f.members.map(function (m) { return m.user_id; }), f.expenses, f.shares, f.settlements);
    var mine = net[me().id] || 0;

    var summary = h('div', { class: 'summary' },
      h('div', null, h('small', null, 'Total shared costs'), h('strong', null, L.formatCents(total))),
      h('div', null, h('small', null, mine > 0 ? 'You’re owed' : mine < 0 ? 'You owe' : 'You’re'),
        h('strong', { class: mine > 0 ? 'pos' : mine < 0 ? 'neg' : null }, mine === 0 ? 'All square' : L.formatCents(Math.abs(mine)))));

    var list = f.expenses.length
      ? h('ul', { class: 'list expenses' }, f.expenses.map(function (e) {
        return h('li', null, h('a', { class: 'row-link', href: '#/f/' + f.id + '/e/' + e.id },
          h('div', { class: 'grow' },
            h('strong', null, e.description || L.categoryLabel(e.category)),
            h('small', { class: 'muted' }, niceDate(e.spent_on), ' · ', L.categoryLabel(e.category), ' · paid by ', nameOf(e.paid_by),
              e.receipt_path ? ' · 🧾' : '')),
          h('span', { class: 'amt' }, L.formatCents(e.amount_cents))));
      }))
      : h('div', { class: 'empty' },
        h('p', null, 'No expenses yet.'),
        h('p', { class: 'muted' }, f.members.length < 2
          ? 'Tip: invite your siblings from the Family tab, then start logging what each of you pays.'
          : 'Add the first thing someone paid for, like a pharmacy bill or parking at the hospital.'));

    render(famHeader('expenses'), summary,
      h('a', { class: 'btn primary block', href: '#/f/' + f.id + '/add' }, '+ Add an expense'),
      list);
  }

  // Shrink photos before upload so they're quick on phones and use less storage.
  async function prepareReceipt(file) {
    if (file.type === 'application/pdf') return { blob: file, ext: 'pdf', type: file.type };
    try {
      var bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      var max = 1600, scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      var blob = await new Promise(function (res) { c.toBlob(res, 'image/jpeg', 0.82); });
      if (blob) return { blob: blob, ext: 'jpg', type: 'image/jpeg' };
    } catch (e) { /* fall through and upload the original */ }
    var ext = { 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/jpeg': 'jpg' }[file.type];
    if (!ext) throw new Error('Please choose a photo (JPG, PNG or HEIC) or a PDF.');
    return { blob: file, ext: ext, type: file.type };
  }

  function viewExpenseForm(eid) {
    var f = state.fam, uid = me().id;
    var existing = eid ? f.expenses.find(function (e) { return e.id === eid; }) : null;
    if (eid && !existing) return go('#/f/' + f.id);
    if (existing && existing.created_by !== uid) { toast('Only the person who added this expense can change it.', true); return go('#/f/' + f.id + '/e/' + eid); }
    var oldShares = existing ? f.shares.filter(function (s) { return s.expense_id === eid; }).map(function (s) { return s.user_id; }) : null;

    var amount = h('input', { type: 'text', inputmode: 'decimal', required: true, placeholder: '0.00', autocomplete: 'off',
      value: existing ? (existing.amount_cents / 100).toFixed(2) : '' });
    var date = h('input', { type: 'date', required: true, max: todayIso(), value: existing ? existing.spent_on : todayIso() });
    var cat = h('select', { required: true }, L.CATEGORIES.map(function (c) {
      return h('option', { value: c[0], selected: existing ? existing.category === c[0] : c[0] === 'medication' }, c[1]);
    }));
    var desc = h('input', { type: 'text', maxlength: '300', placeholder: 'e.g. Shoppers Drug Mart – Mom’s prescriptions',
      value: existing ? existing.description : '' });
    var paidBy = h('select', null, f.members.map(function (m) {
      return h('option', { value: m.user_id, selected: existing ? existing.paid_by === m.user_id : m.user_id === uid }, nameOf(m.user_id));
    }));
    var shareBoxes = f.members.map(function (m) {
      var cb = h('input', { type: 'checkbox', value: m.user_id, checked: oldShares ? oldShares.indexOf(m.user_id) >= 0 : true });
      return { cb: cb, el: h('label', { class: 'check' }, cb, ' ', nameOf(m.user_id)) };
    });
    var splitPreview = h('small', { class: 'muted' });
    function updatePreview() {
      var cents = L.parseCents(amount.value);
      var chosen = shareBoxes.filter(function (s) { return s.cb.checked; }).length;
      splitPreview.textContent = cents && chosen
        ? 'Split evenly: ' + L.formatCents(Math.floor(cents / chosen)) + (cents % chosen ? '–' + L.formatCents(Math.ceil(cents / chosen)) : '') + ' each.'
        : chosen ? '' : 'Pick at least one person.';
    }
    amount.addEventListener('input', updatePreview);
    shareBoxes.forEach(function (s) { s.cb.addEventListener('change', updatePreview); });
    updatePreview();

    var photo = h('input', { type: 'file', accept: 'image/*,application/pdf' });
    var removeReceipt = existing && existing.receipt_path ? h('input', { type: 'checkbox' }) : null;
    var btn = h('button', { class: 'btn primary', type: 'submit' }, existing ? 'Save changes' : 'Add expense');

    var form = h('form', {
      class: 'stack', onsubmit: async function (ev) {
        ev.preventDefault();
        var cents = L.parseCents(amount.value);
        if (!cents) return toast('Enter an amount like 24.99', true);
        var shareWith = shareBoxes.filter(function (s) { return s.cb.checked; }).map(function (s) { return s.cb.value; });
        if (!shareWith.length) return toast('Choose at least one person to share this expense.', true);
        busy(btn, true, 'Saving…');
        var newPath = null;
        try {
          var receiptPath = existing ? existing.receipt_path : null;
          if (removeReceipt && removeReceipt.checked) receiptPath = null;
          if (photo.files && photo.files[0]) {
            var prepared = await prepareReceipt(photo.files[0]);
            newPath = f.id + '/' + crypto.randomUUID() + '.' + prepared.ext;
            must(await sb.storage.from('receipts').upload(newPath, prepared.blob, { contentType: prepared.type, upsert: false }));
            receiptPath = newPath;
          }
          var savedId = must(await sb.rpc('save_expense', {
            p_id: existing ? existing.id : null, p_family_id: f.id, p_paid_by: paidBy.value,
            p_amount_cents: cents, p_spent_on: date.value, p_category: cat.value,
            p_description: desc.value.trim(), p_receipt_path: receiptPath, p_share_with: shareWith
          }));
          if (existing && existing.receipt_path && existing.receipt_path !== receiptPath) {
            await sb.storage.from('receipts').remove([existing.receipt_path]);
          }
          toast(existing ? 'Expense updated' : 'Expense added');
          await loadFamily(f.id);
          go('#/f/' + f.id + (existing ? '/e/' + savedId : ''));
        } catch (err) {
          if (newPath) sb.storage.from('receipts').remove([newPath]);
          toast(friendlyError(err), true);
          busy(btn, false);
        }
      }
    },
      field('Amount (CAD)', amount),
      field('Date paid', date),
      field('Category', cat),
      field('What was it for?', desc),
      field('Who paid?', paidBy),
      h('fieldset', { class: 'field' }, h('legend', null, 'Shared by'), shareBoxes.map(function (s) { return s.el; }), splitPreview),
      field(existing && existing.receipt_path ? 'Replace receipt photo' : 'Receipt photo (optional)', photo,
        'Keep receipts for medical expenses: you may need them at tax time.'),
      removeReceipt ? h('label', { class: 'check' }, removeReceipt, ' Remove the current receipt') : null,
      h('div', { class: 'actions' }, btn, h('a', { class: 'btn', href: existing ? '#/f/' + f.id + '/e/' + existing.id : '#/f/' + f.id }, 'Cancel')));

    render(h('section', { class: 'card' }, h('h1', null, existing ? 'Edit expense' : 'Add an expense'), form));
    if (!existing) amount.focus();
  }

  async function viewExpenseDetail(eid) {
    var f = state.fam;
    var e = f.expenses.find(function (x) { return x.id === eid; });
    if (!e) { await loadFamily(f.id); e = state.fam.expenses.find(function (x) { return x.id === eid; }); }
    if (!e) { toast('That expense was deleted.', true); return go('#/f/' + f.id); }
    var shares = f.shares.filter(function (s) { return s.expense_id === eid; });
    var mineToEdit = e.created_by === me().id;
    var receiptBox = h('div', { class: 'receipt' });

    if (e.receipt_path) {
      receiptBox.append(h('p', { class: 'muted' }, 'Loading receipt…'));
      sb.storage.from('receipts').createSignedUrl(e.receipt_path, 600).then(function (res) {
        receiptBox.replaceChildren();
        if (res.error) return receiptBox.append(h('p', { class: 'muted' }, 'Couldn’t load the receipt.'));
        var url = res.data.signedUrl;
        if (/\.pdf$/i.test(e.receipt_path)) receiptBox.append(h('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener' }, 'Open receipt (PDF)'));
        else receiptBox.append(h('a', { href: url, target: '_blank', rel: 'noopener' }, h('img', { src: url, alt: 'Receipt photo' })));
      });
    }

    var delBtn = mineToEdit ? h('button', {
      class: 'btn danger', type: 'button', onclick: async function () {
        if (!delBtn.dataset.confirm) { delBtn.dataset.confirm = '1'; delBtn.textContent = 'Tap again to delete'; return; }
        busy(delBtn, true, 'Deleting…');
        try {
          must(await sb.from('expenses').delete().eq('id', e.id));
          if (e.receipt_path) await sb.storage.from('receipts').remove([e.receipt_path]);
          toast('Expense deleted');
          go('#/f/' + f.id);
        } catch (err) { toast(friendlyError(err), true); busy(delBtn, false); }
      }
    }, 'Delete') : null;

    render(h('p', null, h('a', { class: 'link', href: '#/f/' + f.id }, '‹ All expenses')),
      h('section', { class: 'card' },
        h('div', { class: 'detail-head' },
          h('h1', null, L.formatCents(e.amount_cents)),
          h('span', { class: 'pill' }, L.categoryLabel(e.category))),
        e.description ? h('p', { class: 'lead' }, e.description) : null,
        h('dl', { class: 'facts' },
          h('dt', null, 'Date'), h('dd', null, niceDate(e.spent_on)),
          h('dt', null, 'Paid by'), h('dd', null, nameOf(e.paid_by)),
          h('dt', null, 'Split'), h('dd', null, h('ul', { class: 'plain' }, shares.map(function (s) {
            return h('li', null, nameOf(s.user_id), ': ', L.formatCents(s.share_cents));
          }))),
          h('dt', null, 'Added by'), h('dd', null, nameOf(e.created_by))),
        receiptBox,
        mineToEdit
          ? h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/f/' + f.id + '/edit/' + e.id }, 'Edit'), delBtn)
          : h('p', { class: 'muted small' }, 'Only ', nameOf(e.created_by), ' can edit or delete this expense.')));
  }

  // ---------------------------------------------------------------------------
  // Balances and settling up
  // ---------------------------------------------------------------------------

  function viewBalances() {
    var f = state.fam, uid = me().id;
    var net = L.netBalances(f.members.map(function (m) { return m.user_id; }), f.expenses, f.shares, f.settlements);
    var steps = L.whoOwesWhom(net);

    var stepList = steps.length
      ? h('ul', { class: 'list' }, steps.map(function (s) {
        var involved = s.from === uid || s.to === uid;
        return h('li', { class: 'owe' },
          h('div', { class: 'grow' }, h('strong', null, nameOf(s.from)), ' owes ', h('strong', null, nameOf(s.to))),
          h('span', { class: 'amt' }, L.formatCents(s.amount_cents)),
          involved ? h('button', { class: 'btn small', type: 'button', onclick: function () { settleForm(s); } }, 'Mark paid') : null);
      }))
      : h('div', { class: 'empty' }, h('p', null, '🎉 Everyone is square.'));

    var perPerson = h('ul', { class: 'list' }, f.members.map(function (m) {
      var v = net[m.user_id] || 0;
      return h('li', null, h('div', { class: 'grow' }, nameOf(m.user_id)),
        h('span', { class: 'amt ' + (v > 0 ? 'pos' : v < 0 ? 'neg' : '') },
          v > 0 ? 'is owed ' + L.formatCents(v) : v < 0 ? 'owes ' + L.formatCents(-v) : 'square'));
    }));

    var history = f.settlements.length ? h('section', { class: 'card' },
      h('h2', null, 'Payments between siblings'),
      h('ul', { class: 'list' }, f.settlements.map(function (p) {
        var del = p.created_by === uid ? h('button', {
          class: 'btn small ghost', type: 'button', title: 'Delete this payment record', onclick: async function () {
            if (!del.dataset.confirm) { del.dataset.confirm = '1'; del.textContent = 'Sure?'; return; }
            try { must(await sb.from('settlements').delete().eq('id', p.id)); toast('Payment removed'); route(); }
            catch (err) { toast(friendlyError(err), true); }
          }
        }, 'Undo') : null;
        return h('li', null,
          h('div', { class: 'grow' }, nameOf(p.from_user), ' paid ', nameOf(p.to_user),
            h('small', { class: 'muted' }, niceDate(p.settled_on), p.note ? ' · ' + p.note : '')),
          h('span', { class: 'amt' }, L.formatCents(p.amount_cents)), del);
      }))) : null;

    render(famHeader('balances'),
      h('section', { class: 'card' }, h('h2', null, 'To even things up'), stepList,
        h('p', { class: 'muted small' }, 'When someone pays a sibling back (e-Transfer, cash…), tap “Mark paid” to record it.')),
      h('section', { class: 'card' }, h('h2', null, 'Each person'), perPerson),
      history);
  }

  function settleForm(step) {
    var f = state.fam;
    var amount = h('input', { type: 'text', inputmode: 'decimal', required: true, value: (step.amount_cents / 100).toFixed(2) });
    var date = h('input', { type: 'date', required: true, max: todayIso(), value: todayIso() });
    var note = h('input', { type: 'text', maxlength: '200', placeholder: 'e.g. Interac e-Transfer' });
    var btn = h('button', { class: 'btn primary', type: 'submit' }, 'Record payment');
    render(h('section', { class: 'card narrow' },
      h('h1', null, 'Record a payment'),
      h('p', null, h('strong', null, nameOf(step.from)), ' paid ', h('strong', null, nameOf(step.to)), '.'),
      h('form', {
        class: 'stack', onsubmit: async function (ev) {
          ev.preventDefault();
          var cents = L.parseCents(amount.value);
          if (!cents) return toast('Enter an amount like 50.00', true);
          busy(btn, true, 'Saving…');
          try {
            must(await sb.from('settlements').insert({
              family_id: f.id, from_user: step.from, to_user: step.to,
              amount_cents: cents, settled_on: date.value, note: note.value.trim(), created_by: me().id
            }));
            toast('Payment recorded');
            go('#/f/' + f.id + '/balances');
          } catch (err) { toast(friendlyError(err), true); busy(btn, false); }
        }
      }, field('Amount (CAD)', amount), field('Date', date), field('Note (optional)', note),
        h('div', { class: 'actions' }, btn, h('a', { class: 'btn', href: '#/f/' + f.id + '/balances' }, 'Cancel')))));
  }

  // ---------------------------------------------------------------------------
  // Family tab: members and invite link
  // ---------------------------------------------------------------------------

  function viewFamily() {
    var f = state.fam, uid = me().id;
    var linkBox = h('div', { class: 'invite' });
    var inviteBtn = h('button', {
      class: 'btn primary', type: 'button', onclick: async function () {
        busy(inviteBtn, true, 'Making link…');
        try {
          var row = must(await sb.from('invites').insert({ family_id: f.id, created_by: uid }).select('code, expires_at').single());
          var url = appUrl() + '#/join/' + row.code;
          var input = h('input', { type: 'text', readonly: true, value: url, onclick: function () { this.select(); } });
          var shareBtn = h('button', {
            class: 'btn', type: 'button', onclick: async function () {
              var text = 'Join our family space on SiblingTab so we can track and share care costs together: ' + url;
              if (navigator.share) { try { await navigator.share({ title: 'SiblingTab invite', text: text }); } catch (e) { /* cancelled */ } }
              else { try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch (e) { input.select(); toast('Copy the link above'); } }
            }
          }, navigator.share ? 'Share link' : 'Copy link');
          linkBox.replaceChildren(input, h('div', { class: 'actions' }, shareBtn),
            h('small', { class: 'muted' }, 'Anyone with this link can join until ', niceDate(row.expires_at.slice(0, 10)), '. Only send it to family.'));
        } catch (err) { toast(friendlyError(err), true); } finally { busy(inviteBtn, false); }
      }
    }, 'Get an invite link');

    var meRow = f.members.find(function (m) { return m.user_id === uid; });
    var nameInput = h('input', { type: 'text', maxlength: '60', required: true, value: meRow ? meRow.display_name : '' });
    var nameBtn = h('button', { class: 'btn', type: 'submit' }, 'Save');
    var famInput = h('input', { type: 'text', maxlength: '80', required: true, value: f.name });
    var famBtn = h('button', { class: 'btn', type: 'submit' }, 'Save');

    render(famHeader('family'),
      h('section', { class: 'card' },
        h('h2', null, 'Members'),
        h('ul', { class: 'list' }, f.members.map(function (m) {
          return h('li', null, h('div', { class: 'grow' }, nameOf(m.user_id)),
            h('small', { class: 'muted' }, m.role === 'owner' ? 'Started this space' : 'Joined ' + niceDate(m.joined_at.slice(0, 10))));
        }))),
      h('section', { class: 'card' },
        h('h2', null, 'Invite a sibling'),
        h('p', null, 'Each sibling uses their own account. Send them a link and they’ll be able to see and add expenses.'),
        inviteBtn, linkBox),
      h('section', { class: 'card' },
        h('h2', null, 'Settings'),
        h('form', {
          class: 'inline', onsubmit: async function (ev) {
            ev.preventDefault(); busy(nameBtn, true, '…');
            try {
              must(await sb.from('family_members').update({ display_name: nameInput.value.trim() }).eq('family_id', f.id).eq('user_id', uid));
              await loadFamily(f.id); toast('Name updated'); viewFamily();
            } catch (err) { toast(friendlyError(err), true); busy(nameBtn, false); }
          }
        }, field('Your name in this family', nameInput), nameBtn),
        h('form', {
          class: 'inline', onsubmit: async function (ev) {
            ev.preventDefault(); busy(famBtn, true, '…');
            try {
              must(await sb.from('families').update({ name: famInput.value.trim() }).eq('id', f.id));
              await loadFamily(f.id); toast('Family renamed'); viewFamily();
            } catch (err) { toast(friendlyError(err), true); busy(famBtn, false); }
          }
        }, field('Family space name', famInput), famBtn)));
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  function viewExport() {
    var f = state.fam;
    var years = {};
    f.expenses.forEach(function (e) { years[e.spent_on.slice(0, 4)] = true; });
    f.settlements.forEach(function (p) { years[p.settled_on.slice(0, 4)] = true; });
    var yearList = Object.keys(years).sort().reverse();
    var sel = h('select', null, h('option', { value: '' }, 'All years'),
      yearList.map(function (y) { return h('option', { value: y, selected: y === yearList[0] }, y); }));
    var btn = h('button', {
      class: 'btn primary', type: 'button', onclick: function () {
        var csv = L.buildCsv(f.members, f.expenses, f.shares, f.settlements, sel.value);
        var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
        var a = h('a', { href: URL.createObjectURL(blob),
          download: 'SiblingTab - ' + (f.name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'family') + ' - ' + (sel.value || 'all years') + '.csv' });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      }
    }, 'Download spreadsheet');
    render(famHeader('export'),
      h('section', { class: 'card' },
        h('h2', null, 'Download for tax time'),
        h('p', null, 'Get every expense and sibling payment as a spreadsheet that opens in Excel, Numbers or Google Sheets. Each person’s share is in its own column.'),
        f.expenses.length ? [field('Which year?', sel), btn] : h('p', { class: 'muted' }, 'Add some expenses first.'),
        h('p', { class: 'muted small' }, 'Receipt photos stay in the app: open an expense to view or save its receipt.')));
  }

  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------

  function viewAccount() {
    var out = h('button', {
      class: 'btn', type: 'button', onclick: async function () {
        lsSet('siblingtab.lastFamily', null);
        history.replaceState(null, '', location.pathname + '#/login');
        await sb.auth.signOut();   // the sign-out event shows the login screen
      }
    }, 'Log out');
    render(h('section', { class: 'card narrow' },
      h('h1', null, 'Your account'),
      h('p', null, 'Logged in as ', h('strong', null, me().email)),
      h('p', null, h('a', { class: 'btn', href: '#/families' }, 'My family spaces')),
      out,
      h('p', { class: 'muted small' }, 'Want your account and data deleted? Contact us through siblingtab.com and we’ll take care of it.')));
  }

  // ---------------------------------------------------------------------------
  // Start up
  // ---------------------------------------------------------------------------

  sb.auth.onAuthStateChange(function (event, session) {
    var hadUser = !!me();
    state.session = session;
    if (event === 'PASSWORD_RECOVERY') state.recovering = true;
    if (event === 'SIGNED_OUT') { state.families = null; state.fam = null; }
    // Re-route on sign in / out, but not on silent token refreshes.
    if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && !hadUser) || event === 'SIGNED_OUT') {
      setTimeout(route, 0);
    }
  });

  window.addEventListener('hashchange', route);

  (async function init() {
    var res = await sb.auth.getSession();
    state.session = res.data.session;
    // Tidy the address bar after an email link (?code=...).
    if (/[?&](code|error)=/.test(location.search)) {
      var err = new URLSearchParams(location.search).get('error_description');
      history.replaceState(null, '', location.pathname + location.hash);
      if (err && !state.session) toast('That email link didn’t work here. If you just confirmed your email, log in below.', true);
    }
    route();
  })();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline support is optional */ });
  }
})();
