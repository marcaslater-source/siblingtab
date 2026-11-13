// Test-only stand-in for supabase-js. Keeps a tiny in-memory database in localStorage
// so the app's screens can be clicked through in a browser without a real Supabase project.
// It mimics the shapes the app uses; the real access rules are tested against Postgres.
(function () {
  var KEY = 'mockdb';
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch (e) { return null; } }
  var db = load() || { users: [], session: null, families: [], family_members: [], invites: [], expenses: [], expense_shares: [], settlements: [], profiles: [], files: {} };
  db.profiles = db.profiles || [];
  function save() { localStorage.setItem(KEY, JSON.stringify(db)); }
  function uuid() { return crypto.randomUUID(); }
  function uid() { return db.session && db.session.user.id; }
  function isMember(fid) { return db.family_members.some(function (m) { return m.family_id === fid && m.user_id === uid(); }); }
  var listeners = [];
  function emit(ev) { var s = db.session; listeners.forEach(function (cb) { setTimeout(function () { cb(ev, s); }, 0); }); }
  function ok(data) { return Promise.resolve({ data: data, error: null }); }
  function fail(msg) { return Promise.resolve({ data: null, error: { message: msg } }); }

  var visible = {
    families: function (r) { return isMember(r.id); },
    family_members: function (r) { return isMember(r.family_id); },
    invites: function (r) { return isMember(r.family_id); },
    expenses: function (r) { return isMember(r.family_id); },
    expense_shares: function (r) { return isMember(r.family_id); },
    settlements: function (r) { return isMember(r.family_id); },
    profiles: function (r) { return sharesFamily(r.id); }
  };
  function sharesFamily(other) {
    if (other === uid()) return true;
    return db.family_members.some(function (a) {
      return a.user_id === uid() && db.family_members.some(function (b) { return b.family_id === a.family_id && b.user_id === other; });
    });
  }

  function Query(table) { this.t = table; this.filters = []; this.orders = []; this.op = 'select'; this.one = null; }
  Query.prototype.select = function (cols) { if (this.op === 'select') this.cols = cols; else this.returning = cols; return this; };
  Query.prototype.eq = function (k, v) { this.filters.push([k, v]); return this; };
  Query.prototype.in = function (k, v) { this.filters.push([k, v, 'in']); return this; };
  Query.prototype.upsert = function (row) { this.op = 'upsert'; this.row = row; return this; };
  Query.prototype.order = function (k, o) { this.orders.push([k, !o || o.ascending !== false]); return this; };
  Query.prototype.maybeSingle = function () { this.one = 'maybe'; return this; };
  Query.prototype.single = function () { this.one = 'single'; return this; };
  Query.prototype.insert = function (row) { this.op = 'insert'; this.row = row; return this; };
  Query.prototype.update = function (row) { this.op = 'update'; this.row = row; return this; };
  Query.prototype.delete = function () { this.op = 'delete'; return this; };
  Query.prototype.then = function (res, rej) { return this.run().then(res, rej); };
  Query.prototype.match = function (r) { return this.filters.every(function (f) { return f[2] === 'in' ? f[1].indexOf(r[f[0]]) >= 0 : r[f[0]] === f[1]; }); };
  Query.prototype.run = function () {
    var self = this, t = this.t, rows = db[t];
    if (!uid()) return fail('not signed in');
    if (this.op === 'upsert') {
      if (this.row.id !== uid()) return fail('row-level security');
      var ex = rows.find(function (r) { return r.id === self.row.id; });
      if (ex) Object.assign(ex, this.row); else rows.push(Object.assign({}, this.row));
      save(); return ok(null);
    }
    if (this.op === 'insert') {
      var r = Object.assign({}, this.row);
      if (!isMember(r.family_id)) return fail('new row violates row-level security policy');
      if (t === 'invites') { r.code = uuid().replace(/-/g, ''); r.expires_at = new Date(Date.now() + 14 * 864e5).toISOString(); }
      if (t === 'settlements') { r.id = uuid(); r.created_at = new Date().toISOString(); }
      rows.push(r); save();
      return ok(this.one ? r : [r]);
    }
    var hit = rows.filter(function (r) { return visible[t](r) && self.match(r); });
    if (this.op === 'update') { hit.forEach(function (r) { Object.assign(r, self.row); }); save(); return ok(null); }
    if (this.op === 'delete') {
      if (t === 'expenses' || t === 'settlements') hit = hit.filter(function (r) { return r.created_by === uid(); });
      db[t] = rows.filter(function (r) { return hit.indexOf(r) < 0; });
      if (t === 'expenses') db.expense_shares = db.expense_shares.filter(function (s) { return !hit.some(function (e) { return e.id === s.expense_id; }); });
      save(); return ok(null);
    }
    var out = hit.map(function (r) {
      var c = Object.assign({}, r);
      if (t === 'family_members' && /families\(name\)/.test(self.cols || '')) {
        var f = db.families.find(function (x) { return x.id === r.family_id; }); c.families = { name: f.name };
      }
      return c;
    });
    this.orders.slice().reverse().forEach(function (o) {
      out.sort(function (a, b) { var x = a[o[0]], y = b[o[0]]; return (x < y ? -1 : x > y ? 1 : 0) * (o[1] ? 1 : -1); });
    });
    if (this.one) return ok(out[0] || null);
    return ok(out);
  };

  var rpcs = {
    create_family: function (a) {
      var fid = uuid();
      db.families.push({ id: fid, name: a.family_name.trim(), created_by: uid() });
      db.family_members.push({ family_id: fid, user_id: uid(), display_name: a.my_name.trim(), role: 'owner', joined_at: new Date().toISOString() });
      return fid;
    },
    invite_info: function (a) {
      var i = db.invites.find(function (x) { return x.code === a.invite_code; });
      if (!i) return [];
      return [{ family_name: db.families.find(function (f) { return f.id === i.family_id; }).name, expired: new Date(i.expires_at) < new Date() }];
    },
    join_family: function (a) {
      var i = db.invites.find(function (x) { return x.code === a.invite_code; });
      if (!i) throw new Error('This invite link is invalid or has expired');
      if (!isMember(i.family_id)) db.family_members.push({ family_id: i.family_id, user_id: uid(), display_name: a.my_name.trim(), role: 'member', joined_at: new Date().toISOString() });
      return i.family_id;
    },
    get_monthly_summary: function () { return !!(db.email_prefs && db.email_prefs[uid()]); },
    set_monthly_summary: function (a) { db.email_prefs = db.email_prefs || {}; db.email_prefs[uid()] = !!a.enabled; return !!a.enabled; },
    unsubscribe_by_token: function (a) { db.unsubscribed = (db.unsubscribed || []).concat([a.t]); return null; },
    // The mock treats marc@example.com as the app owner.
    is_app_owner: function () { var u = db.users.find(function (x) { return x.id === uid(); }); return !!u && u.email === 'marc@example.com'; },
    owner_stats: function () {
      if (!rpcs.is_app_owner()) throw new Error('Not allowed');
      var active = db.family_members.filter(function (m) { return !m.left_at; });
      return { generated_at: new Date().toISOString(),
        accounts: { total: db.users.length, confirmed: db.users.length, new_7d: db.users.length, new_30d: db.users.length, signed_in_7d: 1, signed_in_30d: 1,
          no_family: db.users.filter(function (u) { return !active.some(function (m) { return m.user_id === u.id; }); }).length },
        families: { total: db.families.length, with_2_plus: 1, avg_members: 2.0, active_7d: 1, active_30d: 1 },
        members: { active: active.length, former: db.family_members.length - active.length },
        expenses: { total: db.expenses.length, with_receipt: db.expenses.filter(function (e) { return e.receipt_path; }).length,
          new_7d: db.expenses.length, new_30d: db.expenses.length, total_cents: db.expenses.reduce(function (a, e) { return a + e.amount_cents; }, 0) },
        paybacks: { total: db.settlements.length, new_30d: db.settlements.length },
        people_adding_7d: 2, people_adding_30d: 2,
        weekly: [{ week: '2026-11-02', accounts: 0, families: 0, expenses: 0 }, { week: '2026-11-09', accounts: db.users.length, families: db.families.length, expenses: db.expenses.length }] };
    },
    families_deleted_with_me: function () {
      return db.families.filter(function (f) {
        return isMember(f.id) && !db.family_members.some(function (m) { return m.family_id === f.id && m.user_id !== uid() && !m.left_at; });
      }).map(function (f) { return f.id; });
    },
    delete_my_account: function () {
      var me = uid(), gone = rpcs.families_deleted_with_me();
      db.families = db.families.filter(function (f) { return gone.indexOf(f.id) < 0; });
      ['family_members', 'expenses', 'expense_shares', 'settlements', 'invites'].forEach(function (t) {
        db[t] = db[t].filter(function (r) { return gone.indexOf(r.family_id) < 0; });
      });
      db.family_members.forEach(function (m) { if (m.user_id === me) { m.display_name = 'Former member'; m.left_at = new Date().toISOString(); } });
      db.profiles = db.profiles.filter(function (p) { return p.id !== me; });
      db.users = db.users.filter(function (u) { return u.id !== me; });
      return null;
    },
    save_expense: function (a) {
      if (!isMember(a.p_family_id)) throw new Error('row-level security');
      var e;
      if (a.p_id) {
        e = db.expenses.find(function (x) { return x.id === a.p_id && x.created_by === uid(); });
        if (!e) throw new Error('Expense not found, or you did not create it');
        db.expense_shares = db.expense_shares.filter(function (s) { return s.expense_id !== e.id; });
      } else { e = { id: uuid(), family_id: a.p_family_id, created_by: uid(), created_at: new Date().toISOString() }; db.expenses.push(e); }
      Object.assign(e, { paid_by: a.p_paid_by, amount_cents: a.p_amount_cents, spent_on: a.p_spent_on, category: a.p_category, description: a.p_description, receipt_path: a.p_receipt_path });
      var n = a.p_share_with.length, base = Math.floor(a.p_amount_cents / n), extra = a.p_amount_cents - base * n;
      a.p_share_with.forEach(function (u, i) { db.expense_shares.push({ expense_id: e.id, family_id: e.family_id, user_id: u, share_cents: base + (i < extra ? 1 : 0) }); });
      return e.id;
    }
  };

  window.supabase = {
    createClient: function () {
      return {
        auth: {
          getSession: function () { return ok({ session: db.session }); },
          onAuthStateChange: function (cb) { listeners.push(cb); return { data: { subscription: { unsubscribe: function () {} } } }; },
          signUp: function (a) {
            if (db.users.some(function (u) { return u.email === a.email; })) return fail('User already registered');
            var u = { id: uuid(), email: a.email, password: a.password }; db.users.push(u);
            db.session = { user: { id: u.id, email: u.email } }; save(); emit('SIGNED_IN');
            return ok({ session: db.session, user: db.session.user });
          },
          signInWithPassword: function (a) {
            var u = db.users.find(function (x) { return x.email === a.email && x.password === a.password; });
            if (!u) return fail('Invalid login credentials');
            db.session = { user: { id: u.id, email: u.email } }; save(); emit('SIGNED_IN');
            return ok({ session: db.session });
          },
          signOut: function () { db.session = null; save(); emit('SIGNED_OUT'); return ok(null); },
          resetPasswordForEmail: function () { return ok({}); },
          updateUser: function (a) {
            var u = db.users.find(function (x) { return x.id === uid(); });
            if (a.password) u.password = a.password;
            if (a.email) u.pendingEmail = a.email;
            save(); return ok({ user: db.session.user });
          }
        },
        from: function (t) { return new Query(t); },
        rpc: function (name, args) {
          if (!uid() && name !== 'unsubscribe_by_token') return fail('Not signed in');
          try { var r = rpcs[name](args); save(); return ok(r); } catch (e) { return fail(e.message); }
        },
        storage: {
          from: function (bucket) {
            function allowed(path) {
              var top = path.split('/')[0];
              return bucket === 'avatars' ? top === uid() : isMember(top);
            }
            function key(p) { return bucket + ':' + p; }
            return {
              upload: function (path, blob) {
                if (!allowed(path)) return fail('new row violates row-level security policy');
                return new Promise(function (res) {
                  var fr = new FileReader();
                  fr.onload = function () { db.files[key(path)] = fr.result; save(); res({ data: { path: path }, error: null }); };
                  fr.readAsDataURL(blob);
                });
              },
              list: function (prefix) {
                return ok(Object.keys(db.files).filter(function (k) { return k.indexOf(key(prefix + '/')) === 0; })
                  .map(function (k) { return { name: k.slice(key(prefix + '/').length) }; }));
              },
              remove: function (paths) { paths.forEach(function (p) { if (allowed(p)) delete db.files[key(p)]; }); save(); return ok([]); },
              createSignedUrl: function (p) { return db.files[key(p)] ? ok({ signedUrl: db.files[key(p)] }) : fail('not found'); },
              createSignedUrls: function (ps) { return ok(ps.map(function (p) { return { path: p, signedUrl: db.files[key(p)] || null }; })); }
            };
          }
        }
      };
    }
  };
})();
