// Pure money helpers: no network, no page. Used by app.js and by the tests.
(function (root) {
  'use strict';

  var CATEGORIES = [
    ['medication', 'Medication & pharmacy'],
    ['medical', 'Medical & dental'],
    ['care_home', 'Care home / residence'],
    ['home_care', 'Home care & help'],
    ['transport', 'Transport & parking'],
    ['groceries', 'Groceries & meals'],
    ['home', 'Home & repairs'],
    ['equipment', 'Equipment & supplies'],
    ['other', 'Other']
  ];

  function categoryLabel(key) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i][0] === key) return CATEGORIES[i][1];
    return 'Other';
  }

  // "$1,234.5" -> 123450. Returns null if it isn't a sensible positive amount.
  function parseCents(text) {
    if (text == null) return null;
    var s = String(text).replace(/[\s$,]/g, '');
    if (!/^\d+(\.\d{0,2})?$/.test(s) && !/^\.\d{1,2}$/.test(s)) return null;
    var parts = s.split('.');
    var dollars = parseInt(parts[0] || '0', 10);
    var cents = parts[1] ? parseInt((parts[1] + '0').slice(0, 2), 10) : 0;
    var total = dollars * 100 + cents;
    if (!(total > 0) || total > 10000000) return null;
    return total;
  }

  function formatCents(cents) {
    var neg = cents < 0;
    var abs = Math.abs(Math.round(cents));
    var dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var c = String(abs % 100).padStart(2, '0');
    return (neg ? '-' : '') + '$' + dollars + '.' + c;
  }

  // Same even split the database does: leftover cents go one each to the first people.
  function evenSplit(amountCents, userIds) {
    var n = userIds.length;
    if (!n) return [];
    var base = Math.floor(amountCents / n);
    var extra = amountCents - base * n;
    return userIds.map(function (u, i) { return { user_id: u, share_cents: base + (i < extra ? 1 : 0) }; });
  }

  // net[user] > 0 means the family owes them money; < 0 means they owe.
  function netBalances(memberIds, expenses, shares, settlements) {
    var net = {};
    memberIds.forEach(function (id) { net[id] = 0; });
    function add(id, v) { net[id] = (net[id] || 0) + v; }
    expenses.forEach(function (e) { add(e.paid_by, e.amount_cents); });
    shares.forEach(function (s) { add(s.user_id, -s.share_cents); });
    settlements.forEach(function (p) { add(p.from_user, p.amount_cents); add(p.to_user, -p.amount_cents); });
    return net;
  }

  // Turn balances into the fewest simple "A pays B $x" steps (largest debts first).
  function whoOwesWhom(net) {
    var debtors = [], creditors = [];
    Object.keys(net).forEach(function (id) {
      if (net[id] < 0) debtors.push({ id: id, amt: -net[id] });
      else if (net[id] > 0) creditors.push({ id: id, amt: net[id] });
    });
    var byAmt = function (a, b) { return b.amt - a.amt || (a.id < b.id ? -1 : 1); };
    debtors.sort(byAmt); creditors.sort(byAmt);
    var out = [], i = 0, j = 0;
    while (i < debtors.length && j < creditors.length) {
      var pay = Math.min(debtors[i].amt, creditors[j].amt);
      if (pay > 0) out.push({ from: debtors[i].id, to: creditors[j].id, amount_cents: pay });
      debtors[i].amt -= pay; creditors[j].amt -= pay;
      if (debtors[i].amt === 0) i++;
      if (creditors[j].amt === 0) j++;
    }
    return out;
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    // Stop spreadsheet apps treating a cell as a formula.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // One row per expense and per payment, with a column for each person's share.
  function buildCsv(members, expenses, shares, settlements, year) {
    var nameOf = {};
    members.forEach(function (m) { nameOf[m.user_id] = m.display_name; });
    var inYear = function (d) { return !year || String(d).slice(0, 4) === String(year); };
    var sharesBy = {};
    shares.forEach(function (s) { (sharesBy[s.expense_id] = sharesBy[s.expense_id] || {})[s.user_id] = s.share_cents; });
    var money = function (c) { return (c / 100).toFixed(2); };

    var header = ['Type', 'Date', 'Category', 'Description', 'Amount (CAD)', 'Paid by', 'Paid to', 'Receipt photo']
      .concat(members.map(function (m) { return m.display_name + ' share'; }));
    var rows = [header];
    var exp = expenses.filter(function (e) { return inYear(e.spent_on); })
      .slice().sort(function (a, b) { return a.spent_on < b.spent_on ? -1 : a.spent_on > b.spent_on ? 1 : 0; });
    exp.forEach(function (e) {
      var sh = sharesBy[e.id] || {};
      rows.push(['Expense', e.spent_on, categoryLabel(e.category), e.description, money(e.amount_cents),
        nameOf[e.paid_by] || '', '', e.receipt_path ? 'Yes' : 'No']
        .concat(members.map(function (m) { return sh[m.user_id] != null ? money(sh[m.user_id]) : ''; })));
    });
    settlements.filter(function (p) { return inYear(p.settled_on); }).forEach(function (p) {
      rows.push(['Payment between family', p.settled_on, '', p.note, money(p.amount_cents),
        nameOf[p.from_user] || '', nameOf[p.to_user] || '', '']
        .concat(members.map(function () { return ''; })));
    });
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  // How the CRA usually treats each category, for the tax summary. A rough sort, not tax advice.
  var TAX_GROUPS = [
    { key: 'often', label: 'Often claimable as medical expenses',
      hint: 'Prescriptions, dental, medical services. Usually claimed on line 33199 by the sibling who paid.',
      cats: ['medication', 'medical'] },
    { key: 'check', label: 'Sometimes claimable: check the rules',
      hint: 'Care homes, attendant care, equipment, medical travel and accessibility work can count, depending on the situation.',
      cats: ['care_home', 'home_care', 'equipment', 'transport', 'home', 'other'] },
    { key: 'not', label: 'Usually not claimable',
      hint: 'Everyday living costs like groceries and meals.',
      cats: ['groceries'] }
  ];
  function taxGroupOf(cat) {
    for (var i = 0; i < TAX_GROUPS.length; i++) if (TAX_GROUPS[i].cats.indexOf(cat) >= 0) return TAX_GROUPS[i].key;
    return 'check';
  }

  // For one year: what each person paid, grouped as above. People who paid nothing are left out.
  function taxSummary(members, expenses, year) {
    var byPayer = {};
    expenses.forEach(function (e) {
      if (String(e.spent_on).slice(0, 4) !== String(year)) return;
      var p = byPayer[e.paid_by] = byPayer[e.paid_by] || { user_id: e.paid_by, total_cents: 0, groups: {} };
      var g = p.groups[taxGroupOf(e.category)] = p.groups[taxGroupOf(e.category)] ||
        { total_cents: 0, count: 0, missing_receipts: 0, expenses: [] };
      p.total_cents += e.amount_cents;
      g.total_cents += e.amount_cents; g.count++;
      if (!e.receipt_path) g.missing_receipts++;
      g.expenses.push(e);
    });
    var order = members.map(function (m) { return m.user_id; });
    return Object.keys(byPayer).map(function (k) {
      var p = byPayer[k];
      Object.keys(p.groups).forEach(function (gk) {
        p.groups[gk].expenses.sort(function (a, b) { return a.spent_on < b.spent_on ? -1 : a.spent_on > b.spent_on ? 1 : 0; });
      });
      return p;
    }).sort(function (a, b) {
      var ia = order.indexOf(a.user_id), ib = order.indexOf(b.user_id);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    });
  }

  var api = {
    CATEGORIES: CATEGORIES, categoryLabel: categoryLabel, parseCents: parseCents, formatCents: formatCents,
    evenSplit: evenSplit, netBalances: netBalances, whoOwesWhom: whoOwesWhom, buildCsv: buildCsv,
    TAX_GROUPS: TAX_GROUPS, taxGroupOf: taxGroupOf, taxSummary: taxSummary
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.STLogic = api;
})(this);
