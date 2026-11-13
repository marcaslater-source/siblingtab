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
    fam: null,             // data for the open family
    avatars: {}            // user id -> signed photo URL (or null for no photo)
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
      sb.from('family_members').select('user_id, display_name, role, joined_at, left_at').eq('family_id', fid).order('joined_at'),
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
    await loadAvatars(state.fam.members.map(function (m) { return m.user_id; }));
    return state.fam;
  }

  // Profile photos are private: fetch short-lived links for the people we can see.
  async function loadAvatars(userIds) {
    try {
      var ids = userIds.filter(function (id, i) { return userIds.indexOf(id) === i; });
      if (!ids.length) return;
      var rows = must(await sb.from('profiles').select('id, avatar_path').in('id', ids));
      ids.forEach(function (id) { state.avatars[id] = null; });
      var withPhoto = rows.filter(function (r) { return r.avatar_path; });
      if (!withPhoto.length) return;
      var signed = must(await sb.storage.from('avatars').createSignedUrls(withPhoto.map(function (r) { return r.avatar_path; }), 3600));
      withPhoto.forEach(function (r, i) { if (signed[i] && signed[i].signedUrl) state.avatars[r.id] = signed[i].signedUrl; });
    } catch (e) { /* photos are optional; never block the app on them */ }
  }

  function initials(name) {
    var parts = String(name || '?').replace(/\(you\)/, '').trim().split(/\s+/);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }

  // A round photo, or the person's initials if they haven't added one.
  function avatar(uid, size, nameOverride) {
    var url = state.avatars[uid];
    var name = nameOverride || (state.fam ? nameOf(uid) : '');
    var cls = 'avatar' + (size === 'lg' ? ' lg' : size === 'sm' ? ' sm' : '');
    return url ? h('img', { class: cls, src: url, alt: '' })
      : h('span', { class: cls + ' initials', 'aria-hidden': 'true' }, initials(name));
  }
  function activeMembers() {
    return state.fam.members.filter(function (m) { return !m.left_at; });
  }

  function nameOf(uid) {
    var m = state.fam && state.fam.members.find(function (x) { return x.user_id === uid; });
    if (!m || m.left_at) return 'Former member';
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
    if (parts[0] === 'resources') return viewResources();

    if (!me()) {
      if (parts[0] === 'join' && parts[1]) lsSet(PENDING_INVITE, parts[1]);
      return viewAuth(parts[0] === 'signup' ? 'signup' : parts[0] === 'reset' ? 'reset' : 'login');
    }

    if (!(me().id in state.avatars)) loadAvatars([me().id]).then(renderTopbar);

    try {
      if (parts[0] === 'join' && parts[1]) return await viewJoin(parts[1]);
      var pending = lsGet(PENDING_INVITE);
      if (pending) { lsSet(PENDING_INVITE, null); return go('#/join/' + pending); }

      if (parts[0] === 'new') return viewCreateFamily();
      if (parts[0] === 'account') return await viewAccount();
      if (parts[0] === 'stats') return await viewStats();

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
      append(topRight, h('a', { class: 'link account-link', href: '#/account', title: 'Your account' },
        avatar(me().id, 'sm', me().email), h('span', null, 'Account')));
    }
  }

  // ---------------------------------------------------------------------------
  // Sign in / sign up / reset password
  // ---------------------------------------------------------------------------

  var TERMS_URL = 'https://siblingtab.com/terms.html', PRIVACY_URL = 'https://siblingtab.com/privacy.html';
  function ext(href, text) { return h('a', { href: href, target: '_blank', rel: 'noopener' }, text); }
  function legalLinks() {
    return h('p', { class: 'small links-row' }, ext(TERMS_URL, 'Terms of Use'), ext(PRIVACY_URL, 'Privacy Policy'));
  }

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

    // First-time visitors (and invited siblings) land here, so say what SiblingTab is.
    var intro = mode === 'login' ? h('section', { class: 'intro narrow' },
      h('h1', null, 'Share the costs of caring for Mom or Dad, without the awkward math.'),
      h('ul', { class: 'perks' },
        h('li', null, h('strong', null, 'Log every expense'), ' with a photo of the receipt.'),
        h('li', null, h('strong', null, 'See who owes whom'), ', worked out fairly and to the cent.'),
        h('li', null, h('strong', null, 'Get ready for tax time'), ' with a summary of what each of you can likely claim.')),
      h('p', { class: 'small links-row' },
        h('a', { href: '#/resources' }, 'Free caregiver resources'),
        h('a', { href: 'https://siblingtab.com', rel: 'noopener' }, 'Learn more about SiblingTab'))) : null;

    render(intro, h('section', { class: 'card narrow' },
      h('h1', null, mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset your password' : 'Log in'),
      pendingInvite ? h('p', { class: 'note' }, 'You’ve been invited to a family on SiblingTab. Log in or create an account to join.') : null,
      mode === 'signup' ? h('p', { class: 'muted' }, 'One account per person. Each sibling makes their own and joins the family with an invite link.') : null,
      form,
      mode === 'signup' ? h('p', { class: 'muted small' }, 'By creating an account you agree to the ',
        ext(TERMS_URL, 'Terms of Use'), ' and ', ext(PRIVACY_URL, 'Privacy Policy'), '.') : null,
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
    var tabs = [['expenses', 'Expenses'], ['balances', 'Who owes'], ['family', 'Family'], ['export', 'Tax time']];
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
    // People you can pick: current members, plus anyone already on this expense.
    var pickable = f.members.filter(function (m) {
      return !m.left_at || (existing && (existing.paid_by === m.user_id || oldShares.indexOf(m.user_id) >= 0));
    });
    var paidBy = h('select', null, pickable.map(function (m) {
      return h('option', { value: m.user_id, selected: existing ? existing.paid_by === m.user_id : m.user_id === uid }, nameOf(m.user_id));
    }));
    var shareBoxes = pickable.map(function (m) {
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
          h('span', { class: 'pair' }, avatar(s.from, 'sm'), avatar(s.to, 'sm')),
          h('div', { class: 'grow' }, h('strong', null, nameOf(s.from)), ' owes ', h('strong', null, nameOf(s.to))),
          h('span', { class: 'amt' }, L.formatCents(s.amount_cents)),
          involved ? h('button', { class: 'btn small', type: 'button', onclick: function () { settleForm(s); } }, 'Mark paid') : null);
      }))
      : h('div', { class: 'empty' }, h('p', null, '🎉 Everyone is square.'));

    // Former members only appear here if money is still owed to or by them.
    var shown = f.members.filter(function (m) { return !m.left_at || (net[m.user_id] || 0) !== 0; });
    var perPerson = h('ul', { class: 'list' }, shown.map(function (m) {
      var v = net[m.user_id] || 0;
      return h('li', null, avatar(m.user_id), h('div', { class: 'grow' }, nameOf(m.user_id)),
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
        h('ul', { class: 'list' }, activeMembers().map(function (m) {
          return h('li', null, avatar(m.user_id), h('div', { class: 'grow' }, nameOf(m.user_id)),
            h('small', { class: 'muted' }, m.role === 'owner' ? 'Started this space' : 'Joined ' + niceDate(m.joined_at.slice(0, 10))));
        })),
        f.members.length > activeMembers().length
          ? h('p', { class: 'muted small' }, (f.members.length - activeMembers().length) === 1
            ? '1 former member deleted their account. Their past expenses are kept for your totals.'
            : (f.members.length - activeMembers().length) + ' former members deleted their accounts. Their past expenses are kept for your totals.')
          : null,
        h('p', { class: 'small' }, h('a', { href: '#/account' }, 'Change your photo, name or password'))),
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

  // Tax time: what each sibling paid in a year, sorted by how the CRA usually treats it, plus the spreadsheet.
  function viewExport() {
    var f = state.fam;
    var years = {};
    f.expenses.forEach(function (e) { years[e.spent_on.slice(0, 4)] = true; });
    f.settlements.forEach(function (p) { years[p.settled_on.slice(0, 4)] = true; });
    var yearList = Object.keys(years).sort().reverse();
    if (!yearList.length) {
      return render(famHeader('export'), h('section', { class: 'card' },
        h('h2', null, 'Tax time'),
        h('p', { class: 'muted' }, 'Add some expenses first. This page then sorts what each of you paid into what the CRA usually allows, and gives you a spreadsheet.')));
    }
    var year = state.taxYear && years[state.taxYear] ? state.taxYear : yearList[0];
    var sel = h('select', { onchange: function () { state.taxYear = sel.value; viewExport(); } },
      yearList.map(function (y) { return h('option', { value: y, selected: y === year }, y); }));

    var csvBtn = h('button', {
      class: 'btn', type: 'button', onclick: function () {
        var csv = L.buildCsv(f.members, f.expenses, f.shares, f.settlements, year);
        var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
        var a = h('a', { href: URL.createObjectURL(blob),
          download: 'SiblingTab - ' + (f.name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'family') + ' - ' + year + '.csv' });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      }
    }, 'Download spreadsheet');
    var printBtn = h('button', { class: 'btn', type: 'button', onclick: function () {
      document.querySelectorAll('.tax-group').forEach(function (d) { d.open = true; });
      window.print();
    } }, 'Print or save as PDF');

    var summary = L.taxSummary(f.members, f.expenses, year);
    var people = summary.map(function (p) {
      var groups = L.TAX_GROUPS.filter(function (g) { return p.groups[g.key]; }).map(function (g) {
        var d = p.groups[g.key];
        return h('details', { class: 'tax-group tax-' + g.key },
          h('summary', null,
            h('span', { class: 'tax-label' }, g.label,
              h('small', { class: 'muted' }, d.count + (d.count === 1 ? ' expense' : ' expenses') +
                (d.missing_receipts ? ' · ' + d.missing_receipts + ' without a receipt photo' : ''))),
            h('strong', null, L.formatCents(d.total_cents))),
          h('p', { class: 'muted small' }, g.hint),
          h('ul', { class: 'tax-items' }, d.expenses.map(function (e) {
            return h('li', null,
              h('a', { href: '#/f/' + f.id + '/e/' + e.id }, e.description),
              h('span', { class: 'muted small' }, ' ' + niceDate(e.spent_on) + ' · ' + L.categoryLabel(e.category) +
                (e.receipt_path ? '' : ' · no receipt')),
              h('span', { class: 'amt' }, L.formatCents(e.amount_cents)));
          })));
      });
      return h('section', { class: 'card tax-person' },
        h('div', { class: 'pair' }, avatar(p.user_id, 'sm'),
          h('h2', { style: 'margin:0' }, nameOf(p.user_id) + ' paid ' + L.formatCents(p.total_cents))),
        groups);
    });

    render(famHeader('export'),
      h('section', { class: 'card' },
        h('h2', null, 'Tax summary'),
        field('Tax year', sel),
        h('p', null, 'What each of you paid in ', h('strong', null, year), ', sorted by how the CRA usually treats it. ',
          'Generally the sibling who paid a bill is the one who can claim it. Tap a group to see the expenses.'),
        h('div', { class: 'actions no-print' }, printBtn, csvBtn)),
      people.length ? people : h('section', { class: 'card' }, h('p', { class: 'muted' }, 'No expenses in ' + year + ', only paybacks.')),
      h('section', { class: 'card' },
        h('h2', null, 'Before you file'),
        h('ul', { class: 'tax-notes' },
          h('li', null, 'Medical expenses for a parent go on line 33199. Only the part above a minimum, based on your parent’s income, counts.'),
          h('li', null, 'If a sibling paid you back for part of a bill, check with a tax professional about who should claim it.'),
          h('li', null, 'Keep every receipt. Open an expense to view or save its photo.'),
          h('li', null, 'Siblings can often also share the Canada caregiver credit for the same parent, up to one full claim in total.')),
        h('p', { class: 'small no-print' }, h('a', { href: '#/resources' }, 'Caregiver tax checklist and CRA links')),
        h('p', { class: 'muted small' }, 'This is a way to organize your records, not tax advice. Confirm your claims with the CRA or a tax professional.')));
  }

  // Owner-only usage counts, straight from the database. No names, emails or family details.
  async function viewStats() {
    var res = await sb.rpc('owner_stats');
    if (res.error) {
      return render(h('section', { class: 'card narrow' }, h('h1', null, 'Page not found'),
        h('p', null, h('a', { href: '#/' }, '‹ Back'))));
    }
    var d = res.data || {};
    var A = d.accounts || {}, F = d.families || {}, M = d.members || {}, E = d.expenses || {}, P = d.paybacks || {};
    var pct = function (a, b) { return b ? Math.round(100 * a / b) + '%' : '–'; };
    function tile(label, value, sub) {
      return h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, label), h('strong', null, String(value)),
        sub ? h('span', { class: 'muted small' }, sub) : null);
    }
    var weekly = d.weekly || [];
    var maxExp = Math.max.apply(null, [1].concat(weekly.map(function (w) { return w.expenses; })));
    render(
      h('p', null, h('a', { href: '#/account' }, '‹ Back')),
      h('section', { class: 'card' },
        h('h1', null, 'App stats'),
        h('p', { class: 'muted small' }, 'Only you can see this page. Totals across all families, as of ' +
          new Date(d.generated_at || Date.now()).toLocaleString('en-CA', { dateStyle: 'medium', timeStyle: 'short' })),
        h('h2', null, 'People'),
        h('div', { class: 'stats' },
          tile('Accounts', A.total, A.confirmed + ' confirmed their email'),
          tile('New accounts', A.new_7d, 'last 7 days · ' + A.new_30d + ' in 30'),
          tile('Logged in', A.signed_in_7d, 'last 7 days · ' + A.signed_in_30d + ' in 30'),
          tile('Added something', d.people_adding_7d, 'last 7 days · ' + d.people_adding_30d + ' in 30'),
          tile('No family yet', A.no_family, 'signed up but not in a family')),
        h('h2', null, 'Families'),
        h('div', { class: 'stats' },
          tile('Family spaces', F.total, 'avg ' + (F.avg_members == null ? '–' : F.avg_members) + ' members'),
          tile('With 2+ siblings', F.with_2_plus, pct(F.with_2_plus, F.total) + ' of families'),
          tile('Active families', F.active_7d, 'logged an expense in 7 days · ' + F.active_30d + ' in 30'),
          tile('Former members', M.former, M.active + ' current members')),
        h('h2', null, 'Expenses'),
        h('div', { class: 'stats' },
          tile('Expenses logged', E.total, E.new_7d + ' in 7 days · ' + E.new_30d + ' in 30'),
          tile('With a receipt photo', E.with_receipt, pct(E.with_receipt, E.total) + ' of expenses'),
          tile('Total tracked', L.formatCents(E.total_cents || 0), 'across all families'),
          tile('Paybacks recorded', P.total, P.new_30d + ' in 30 days'))),
      h('section', { class: 'card' },
        h('h2', null, 'Last 8 weeks'),
        h('table', { class: 'stats-table' },
          h('thead', null, h('tr', null, h('th', null, 'Week of'), h('th', null, 'New accounts'), h('th', null, 'New families'), h('th', null, 'Expenses'))),
          h('tbody', null, weekly.map(function (w) {
            return h('tr', null,
              h('td', null, niceDate(w.week)),
              h('td', null, String(w.accounts)),
              h('td', null, String(w.families)),
              h('td', null, h('span', { class: 'bar-cell' },
                h('span', { class: 'bar', style: 'width:' + Math.round(100 * w.expenses / maxExp) + '%' }),
                h('span', null, String(w.expenses)))));
          })))));
  }

  // ---------------------------------------------------------------------------
  // Account
  // ---------------------------------------------------------------------------

  // Make a square, small JPEG from any photo the person picks.
  // Free downloads (hosted on the main site) and official CRA pages. Open to everyone.
  function viewResources() {
    var SITE = 'https://siblingtab.com/';
    var CRA = 'https://www.canada.ca/en/revenue-agency/services/';
    function item(href, title, desc, download) {
      return h('li', null,
        h('a', { href: href, target: '_blank', rel: 'noopener' }, title),
        download ? h('span', { class: 'muted small' }, ' (' + download + ')') : null,
        h('br'), h('span', { class: 'muted small' }, desc));
    }
    render(h('section', { class: 'card narrow' },
      h('p', null, h('a', { href: me() ? '#/' : '#/login' }, me() ? '‹ Back' : '‹ Back to log in')),
      h('h1', null, 'Caregiver resources'),
      h('p', { class: 'muted' }, 'Free guides for families sharing the cost of caring for a parent in Canada.'),
      h('h2', null, 'Downloads'),
      h('ul', { class: 'resource-list' },
        item(SITE + 'downloads/caregiver-tax-credit-checklist.pdf', 'Caregiver tax credit checklist',
          'Which credits you can claim for a parent, which sibling should claim them, and the receipts to keep.', 'PDF'),
        item(SITE + 'downloads/sibling-care-cost-split.xlsx', 'Sibling care cost split spreadsheet',
          'Track costs and caregiving hours by sibling, for anyone who prefers a spreadsheet.', 'Excel')),
      h('h2', null, 'Official CRA pages'),
      h('ul', { class: 'resource-list' },
        item(CRA + 'tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/deductions-credits-expenses/canada-caregiver-amount.html',
          'Canada caregiver amount', 'Who qualifies and how much you can claim for a dependent parent.'),
        item(CRA + 'tax/individuals/topics/about-your-tax-return/tax-return/completing-a-tax-return/deductions-credits-expenses/lines-33099-33199-eligible-medical-expenses-you-claim-on-your-tax-return.html',
          'Medical expenses you can claim', 'Which costs count, including many paid for a parent.'),
        item(CRA + 'tax/individuals/segments/tax-credits-deductions-persons-disabilities/disability-tax-credit.html',
          'Disability tax credit', 'A credit that can often be transferred to a supporting family member.')),
      h('p', { class: 'muted small' }, 'This is general information, not tax advice. For your situation, check with the CRA or a tax professional.'),
      legalLinks()));
  }

  async function prepareAvatar(file) {
    var bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    var side = Math.min(bmp.width, bmp.height), out = 320;
    var c = document.createElement('canvas');
    c.width = out; c.height = out;
    c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
    var blob = await new Promise(function (res) { c.toBlob(res, 'image/jpeg', 0.85); });
    if (!blob) throw new Error('Couldn’t read that photo. Try a JPG or PNG.');
    return blob;
  }

  async function viewAccount() {
    var user = me(), uid = user.id;
    var memberships = await loadFamilies();
    var profile = null;
    try { profile = must(await sb.from('profiles').select('id, avatar_path').eq('id', uid).maybeSingle()); } catch (e) { /* not set up yet */ }
    if (!(uid in state.avatars)) await loadAvatars([uid]);
    var myName = memberships.length ? memberships[0].display_name : '';

    // --- Photo ---
    var photoBox = h('div', { class: 'photo-row' });
    var photoInput = h('input', { type: 'file', accept: 'image/*', class: 'visually-hidden', id: 'photo-input' });
    function drawPhoto() {
      photoBox.replaceChildren(avatar(uid, 'lg', myName || user.email),
        h('div', { class: 'actions' },
          h('label', { class: 'btn', for: 'photo-input' }, state.avatars[uid] ? 'Change photo' : 'Add a photo'),
          state.avatars[uid] ? h('button', { class: 'btn ghost', type: 'button', onclick: removePhoto }, 'Remove') : null),
        photoInput);
      renderTopbar();
    }
    async function savePhotoPath(path) {
      must(await sb.from('profiles').upsert({ id: uid, avatar_path: path, updated_at: new Date().toISOString() }));
      var old = profile && profile.avatar_path;
      profile = { id: uid, avatar_path: path };
      if (old && old !== path) await sb.storage.from('avatars').remove([old]);
      delete state.avatars[uid];
      await loadAvatars([uid]);
      drawPhoto();
    }
    photoInput.addEventListener('change', async function () {
      var file = photoInput.files && photoInput.files[0];
      if (!file) return;
      try {
        toast('Uploading photo…');
        var blob = await prepareAvatar(file);
        var path = uid + '/' + crypto.randomUUID() + '.jpg';
        must(await sb.storage.from('avatars').upload(path, blob, { contentType: 'image/jpeg', upsert: false }));
        await savePhotoPath(path);
        toast('Photo updated');
      } catch (err) { toast(friendlyError(err), true); }
      photoInput.value = '';
    });
    async function removePhoto() {
      try { await savePhotoPath(null); toast('Photo removed'); } catch (err) { toast(friendlyError(err), true); }
    }
    drawPhoto();

    // --- Name (used in all your family spaces) ---
    var nameInput = h('input', { type: 'text', maxlength: '60', required: true, value: myName, autocomplete: 'name' });
    var nameBtn = h('button', { class: 'btn', type: 'submit' }, 'Save');
    var nameForm = memberships.length ? h('form', {
      class: 'inline', onsubmit: async function (ev) {
        ev.preventDefault(); busy(nameBtn, true, '…');
        try {
          must(await sb.from('family_members').update({ display_name: nameInput.value.trim() }).eq('user_id', uid));
          myName = nameInput.value.trim(); state.fam = null;
          toast('Name updated in all your family spaces');
        } catch (err) { toast(friendlyError(err), true); } finally { busy(nameBtn, false); }
      }
    }, field('Your name', nameInput, 'This is how your siblings see you.'), nameBtn) : null;

    // --- Email ---
    var emailInput = h('input', { type: 'email', required: true, autocomplete: 'email', inputmode: 'email' });
    var emailBtn = h('button', { class: 'btn', type: 'submit' }, 'Change email');
    var emailForm = h('form', {
      class: 'stack', onsubmit: async function (ev) {
        ev.preventDefault();
        var next = emailInput.value.trim();
        if (next.toLowerCase() === String(user.email).toLowerCase()) return toast('That’s already your email.', true);
        busy(emailBtn, true, 'Sending…');
        try {
          must(await sb.auth.updateUser({ email: next }, { emailRedirectTo: appUrl() }));
          emailInput.value = '';
          toast('Check your inbox: click the confirmation link we sent to finish the change.');
        } catch (err) { toast(friendlyError(err), true); } finally { busy(emailBtn, false); }
      }
    }, field('New email address', emailInput, 'We’ll send a confirmation link. Your email won’t change until you click it.'), emailBtn);

    // --- Password ---
    var cur = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
    var pw1 = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password' });
    var pw2 = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password' });
    var pwBtn = h('button', { class: 'btn', type: 'submit' }, 'Change password');
    var pwForm = h('form', {
      class: 'stack', onsubmit: async function (ev) {
        ev.preventDefault();
        if (pw1.value !== pw2.value) return toast('The two new passwords don’t match.', true);
        if (pw1.value === cur.value) return toast('Choose a password different from your current one.', true);
        busy(pwBtn, true, 'Saving…');
        try {
          // Check the current password first, so someone using an unlocked phone can't change it.
          var check = await sb.auth.signInWithPassword({ email: user.email, password: cur.value });
          if (check.error) throw new Error('Your current password isn’t right.');
          must(await sb.auth.updateUser({ password: pw1.value }));
          cur.value = pw1.value = pw2.value = '';
          toast('Password changed');
        } catch (err) { toast(friendlyError(err), true); } finally { busy(pwBtn, false); }
      }
    }, field('Current password', cur), field('New password', pw1, 'At least 8 characters.'), field('New password again', pw2), pwBtn);

    // --- Delete account ---
    var confirmInput = h('input', { type: 'text', autocomplete: 'off', placeholder: 'DELETE' });
    var delBtn = h('button', { class: 'btn danger', type: 'submit' }, 'Delete my account');
    var delForm = h('form', {
      class: 'stack', onsubmit: async function (ev) {
        ev.preventDefault();
        if (confirmInput.value.trim().toUpperCase() !== 'DELETE') return toast('Type DELETE to confirm.', true);
        busy(delBtn, true, 'Deleting…');
        try {
          // Clear files first: photos and receipts can't be removed from inside the database.
          var doomed = must(await sb.rpc('families_deleted_with_me')) || [];
          for (var i = 0; i < doomed.length; i++) {
            var fid = typeof doomed[i] === 'string' ? doomed[i] : Object.values(doomed[i])[0];
            var files = must(await sb.storage.from('receipts').list(fid, { limit: 1000 }));
            if (files.length) await sb.storage.from('receipts').remove(files.map(function (x) { return fid + '/' + x.name; }));
          }
          var mine = must(await sb.storage.from('avatars').list(uid, { limit: 100 }));
          if (mine.length) await sb.storage.from('avatars').remove(mine.map(function (x) { return uid + '/' + x.name; }));
          must(await sb.rpc('delete_my_account'));
          lsSet('siblingtab.lastFamily', null);
          state.avatars = {};
          history.replaceState(null, '', location.pathname + '#/login');
          await sb.auth.signOut({ scope: 'local' });
          toast('Your account has been deleted.');
        } catch (err) { toast(friendlyError(err), true); busy(delBtn, false); }
      }
    },
      h('p', null, 'This permanently deletes your login, your photo, and any family space where you’re the only member, including its receipts.'),
      h('p', null, 'In family spaces you share, your siblings keep the expense history so their totals stay right, but your name is replaced with “Former member”.'),
      h('p', { class: 'small' }, ext(PRIVACY_URL + '#keep', 'What we keep and for how long')),
      field('Type DELETE to confirm', confirmInput),
      delBtn);

    // Only the app's owner sees the stats link (the database decides who that is).
    var ownerLink = h('p', { class: 'small', hidden: true }, h('a', { href: '#/stats' }, 'App stats (only you see this)'));
    sb.rpc('is_app_owner').then(function (r) { if (r && r.data === true) ownerLink.hidden = false; }, function () {});

    var logout = h('button', {
      class: 'btn', type: 'button', onclick: async function () {
        lsSet('siblingtab.lastFamily', null);
        state.avatars = {};
        history.replaceState(null, '', location.pathname + '#/login');
        await sb.auth.signOut();   // the sign-out event shows the login screen
      }
    }, 'Log out');

    render(
      h('section', { class: 'card' },
        h('h1', null, 'Your account'),
        photoBox,
        nameForm,
        h('p', { class: 'muted small' }, 'Logged in as ', h('strong', null, user.email)),
        h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/families' }, 'My family spaces'), logout),
        h('p', { class: 'small' }, h('a', { href: '#/resources' }, 'Free caregiver resources')),
        ownerLink,
        legalLinks()),
      h('section', { class: 'card' }, h('h2', null, 'Change your password'), pwForm),
      h('section', { class: 'card' }, h('h2', null, 'Change your email'), emailForm),
      h('details', { class: 'card danger-zone' },
        h('summary', null, 'Delete my account'),
        delForm));
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
