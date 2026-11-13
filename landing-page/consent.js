/* SiblingTab: opt-in Google Analytics for siblingtab.com.
   Analytics is OFF until the visitor clicks "Allow" (Quebec Law 25 / PIPEDA).
   The choice is remembered in this browser. Any link with data-cookie-settings
   reopens the banner. Not used in the app (app.siblingtab.com). */
(function () {
  var GA_ID = 'G-F5ZQJB9XVB';
  var KEY = 'st_analytics_choice'; // "yes" or "no"

  function getChoice() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function setChoice(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  function loadAnalytics() {
    if (window.__stGaLoaded) return;
    window.__stGaLoaded = true;
    window['ga-disable-' + GA_ID] = false;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false
    });
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
  }

  function stopAnalytics() {
    window['ga-disable-' + GA_ID] = true;
    // Remove Google Analytics cookies (_ga, _ga_XXXX) for this site.
    var host = location.hostname.replace(/^www\./, '');
    document.cookie.split(';').forEach(function (c) {
      var name = c.split('=')[0].trim();
      if (name.indexOf('_ga') === 0) {
        ['', '; domain=' + host, '; domain=.' + host].forEach(function (d) {
          document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' + d;
        });
      }
    });
  }

  var css =
    '#st-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;max-width:560px;margin:0 auto;' +
    'background:#fff;color:#1d2a2a;border:1px solid #e4ddd2;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.12);' +
    'padding:16px 18px;font:15px/1.5 Inter,system-ui,-apple-system,sans-serif}' +
    '#st-consent p{margin:0 0 12px}#st-consent a{color:#1f5c57;font-weight:600}' +
    '#st-consent .st-btns{display:flex;gap:10px;flex-wrap:wrap}' +
    '#st-consent button{flex:1 1 120px;font:600 15px/1 Inter,system-ui,sans-serif;padding:11px 14px;border-radius:10px;cursor:pointer;' +
    'border:2px solid #1f5c57}' +
    '#st-consent .st-yes{background:#1f5c57;color:#fff}#st-consent .st-no{background:#fff;color:#1f5c57}';

  function showBanner() {
    if (document.getElementById('st-consent')) return;
    if (!document.getElementById('st-consent-css')) {
      var st = document.createElement('style');
      st.id = 'st-consent-css';
      st.textContent = css;
      document.head.appendChild(st);
    }
    var box = document.createElement('div');
    box.id = 'st-consent';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Analytics choice');
    box.innerHTML =
      '<p>Can we count your visit with Google Analytics? It helps us see which pages are useful. ' +
      'No ads, and it is never used in the app. <a href="/privacy.html#cookies">Privacy details</a></p>' +
      '<div class="st-btns"><button type="button" class="st-no">No thanks</button>' +
      '<button type="button" class="st-yes">Allow</button></div>';
    box.querySelector('.st-yes').onclick = function () { setChoice('yes'); box.remove(); loadAnalytics(); };
    box.querySelector('.st-no').onclick = function () { setChoice('no'); box.remove(); stopAnalytics(); };
    document.body.appendChild(box);
  }

  function init() {
    var choice = getChoice();
    if (choice === 'yes') loadAnalytics();
    else if (choice !== 'no') showBanner();

    document.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-cookie-settings]');
      if (t) { e.preventDefault(); showBanner(); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
