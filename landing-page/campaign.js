/* SiblingTab: remember where a visitor came from (e.g. a printed flyer QR code).
   Reads utm_source / utm_medium / utm_campaign / utm_content from the page address,
   keeps them for this browser tab only (sessionStorage), and adds them as hidden
   fields to the signup forms so the Formspree email says which flyer the signup came from.
   No cookies, no personal data, and it works even if analytics is declined. */
(function () {
  var KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'];
  var saved = {};
  try { saved = JSON.parse(sessionStorage.getItem('st_utm') || '{}'); } catch (e) {}
  var params = new URLSearchParams(location.search);
  var found = false;
  KEYS.forEach(function (k) {
    var v = (params.get(k) || '').slice(0, 60);
    if (v) { saved[k] = v; found = true; }
  });
  if (found) { try { sessionStorage.setItem('st_utm', JSON.stringify(saved)); } catch (e) {} }
  var parts = KEYS.filter(function (k) { return saved[k]; }).map(function (k) { return k.slice(4) + '=' + saved[k]; });
  if (!parts.length) return;
  var value = parts.join('&');
  function fill() {
    document.querySelectorAll('form[data-fs]').forEach(function (f) {
      if (f.querySelector('input[name="campaign"]')) return;
      var i = document.createElement('input');
      i.type = 'hidden'; i.name = 'campaign'; i.value = value;
      f.appendChild(i);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill); else fill();
})();
