/* Canine Keepsakes — shared store logic (no build step) */
const CK = (() => {
  let catalog = null;

  async function load() {
    if (catalog) return catalog;
    const res = await fetch('data/catalog.json');
    catalog = await res.json();
    return catalog;
  }

  const params = new URLSearchParams(location.search);
  /* Currency: prices stored in GBP base, displayed in the visitor's region currency via
     region.js (fixed per-currency table). Falls back to £ if region.js isn't loaded.
     `gbp`/`money` both format a number that's already in the active currency. */
  const gbp = n => (window.CKRegion ? window.CKRegion.money(Number(n)) : '£' + Number(n).toFixed(2));

  /* ── basket (localStorage) ── */
  const KEY = 'ck-basket-v1';
  const getBasket = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
  const saveBasket = b => { localStorage.setItem(KEY, JSON.stringify(b)); renderCount(); };

  function addToBasket(item) {
    const b = getBasket();
    const match = b.find(x => x.productSlug === item.productSlug && x.designId === item.designId && x.colour === item.colour && x.size === item.size);
    if (match) match.qty += item.qty; else b.push(item);
    saveBasket(b);
  }
  function removeFromBasket(i) { const b = getBasket(); b.splice(i, 1); saveBasket(b); }
  /* active-currency unit price for a cart item (fixed per-currency table via region.js;
     falls back to the item's stored GBP price). qty NOT included. */
  const unit = item => (window.CKRegion ? window.CKRegion.priceOf(item) : (parseFloat(item.price) || 0));
  const lineTotal = item => unit(item) * (parseInt(item.qty) || 1);
  const basketTotal = () => getBasket().reduce((s, x) => s + lineTotal(x), 0);
  const basketCount = () => getBasket().reduce((s, x) => s + (parseInt(x.qty) || 1), 0);

  function renderCount() {
    document.querySelectorAll('.basket-count').forEach(el => { el.textContent = basketCount(); });
  }

  /* ── images: Drive thumbnail with graceful placeholder fallback ── */
  function designImg(design, label) {
    const wrap = document.createElement('div');
    wrap.className = 'ph-art';
    wrap.innerHTML = `<span>${label || '🐾'}</span>`;
    const img = new Image();
    img.alt = label || 'design';
    img.decoding = 'async';
    img.onload = () => { wrap.className = ''; wrap.innerHTML = ''; wrap.appendChild(img); };
    img.onerror = () => {};
    img.src = design.thumb;
    return wrap;
  }

  /* ── scroll reveal + animated counters ── */
  function countUp(el) {
    const end = +el.dataset.count, suf = el.dataset.suffix || '';
    let t0 = null;
    requestAnimationFrame(function step(ts) {
      if (!t0) t0 = ts;
      const p = Math.min((ts - t0) / 1100, 1);
      el.textContent = Math.round(end * (1 - Math.pow(1 - p, 3))) + suf;
      if (p < 1) requestAnimationFrame(step);
    });
  }
  function reveals() {
    const io = new IntersectionObserver(es => es.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('in');
        if (e.target.dataset && e.target.dataset.count != null) countUp(e.target);
        io.unobserve(e.target);
      }
    }), { threshold: .12 });
    document.querySelectorAll('.reveal:not(.in), [data-count]').forEach(el => io.observe(el));
  }

  /* ── global premium motion: grain, header-shrink, magnetic buttons, 3D tilt ── */
  function motionChrome() {
    if (!document.querySelector('.ck-grain')) {
      const g = document.createElement('div'); g.className = 'ck-grain'; document.body.appendChild(g);
    }
    const hdr = document.querySelector('.site-header');
    if (hdr) {
      const onsc = () => hdr.classList.toggle('scrolled', window.scrollY > 40);
      onsc(); window.addEventListener('scroll', onsc, { passive: true });
    }
    if (window.matchMedia && window.matchMedia('(hover:hover)').matches) {
      let mag = null, tilt = null;
      document.addEventListener('pointermove', e => {
        const t = e.target;
        const m = t.closest ? t.closest('[data-mag]') : null;
        if (m) { if (mag && mag !== m) mag.style.transform = ''; const r = m.getBoundingClientRect();
          m.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * .3}px,${(e.clientY - r.top - r.height / 2) * .4}px)`; mag = m; }
        else if (mag) { mag.style.transform = ''; mag = null; }
        const k = t.closest ? t.closest('[data-tilt], .card') : null;
        if (k) { if (tilt && tilt !== k) tilt.style.transform = ''; const r = k.getBoundingClientRect();
          const px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5;
          k.style.transform = `perspective(900px) rotateY(${px * 9}deg) rotateX(${-py * 9}deg) translateY(-6px)`; tilt = k; }
        else if (tilt) { tilt.style.transform = ''; tilt = null; }
      }, { passive: true });
    }
  }

  /* ── shared chrome ── */
  function header(active) {
    return `
    <header class="site-header"><div class="wrap">
      <a class="logo" href="index.html"><img class="logo-badge" src="images/logo.png" alt="Canine Keepsakes" width="42" height="42"> Canine Keepsakes</a>
      <nav class="nav">
        <a href="index.html#collections" ${active==='collections'?'style="opacity:1"':''}>Collections</a>
        <a href="quiz.html" ${active==='quiz'?'style="opacity:1"':''}>Alter-Ego Quiz</a>
        <a href="submit-design.html" ${active==='submit'?'style="opacity:1"':''}>Custom Dog Art</a>
        <a href="creators.html" ${active==='creators'?'style="opacity:1"':''}>Design for us</a>
        <a href="about.html" ${active==='about'?'style="opacity:1"':''}>About</a>
        <a href="account.html" ${active==='account'?'style="opacity:1"':''}>Account</a>
        <a class="basket-btn" href="basket.html">Basket <span class="basket-count">0</span></a>
      </nav>
    </div></header>`;
  }
  function footer() {
    const y = new Date().getFullYear();
    return `
    <footer class="site-footer">
      <div class="wrap foot-grid">
        <div class="foot-brand">
          <img class="foot-logo" src="images/logo-mono.png" alt="Canine Keepsakes" width="64" height="64">
          <div class="foot-title">Canine Keepsakes</div>
          <div class="muted">Original dog artwork for people who are properly obsessed with their dogs. Designed as collections, personalised by breed, printed to order.</div>
        </div>
        <div class="foot-col">
          <h4>Shop</h4>
          <a href="index.html#collections">Collections</a>
          <a href="submit-design.html">Custom Dog Art</a>
          <a href="quiz.html">Alter-Ego Quiz</a>
          <a href="creators.html">Design for us</a>
          <a href="basket.html">Basket</a>
          <a href="account.html">Account</a>
        </div>
        <div class="foot-col">
          <h4>Help</h4>
          <a href="about.html">About</a>
          <a href="privacy.html">Privacy Policy</a>
          <a href="mailto:caninekeepsakes.admin@gmail.com">Contact</a>
        </div>
        <div class="foot-col">
          <h4>Trust</h4>
          <ul class="foot-trust">
            <li>Printed to order</li>
            <li>UK delivery</li>
            <li>Secure PayPal checkout</li>
            <li>No mass-produced stock</li>
          </ul>
        </div>
      </div>
      <div class="wrap foot-bottom muted">© ${y} Canine Keepsakes. Original dog artwork, printed to order.</div>
    </footer>`;
  }

  /* ── cookie / essential-storage notice (no tracking, so a notice not a gate) ── */
  function cookieNotice() {
    try { if (localStorage.getItem('ck-cookie-ok')) return; } catch (_) {}
    const bar = document.createElement('div');
    bar.className = 'ck-cookie';
    bar.setAttribute('role', 'note');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#1c1c1c;color:#fff;padding:14px 18px;display:flex;gap:14px;align-items:center;justify-content:center;flex-wrap:wrap;font-size:.92rem';
    bar.innerHTML = 'We use only essential storage to run the shop (your basket and login) — no tracking or ads. <a href="privacy.html" style="color:#9fd3ff">Learn more</a> <button type="button" class="ck-cookie-ok" style="margin-left:8px;padding:8px 16px;border:0;border-radius:8px;background:#fff;color:#1c1c1c;font-weight:600;cursor:pointer">OK</button>';
    document.body.appendChild(bar);
    bar.querySelector('.ck-cookie-ok').onclick = () => { try { localStorage.setItem('ck-cookie-ok', '1'); } catch (_) {} bar.remove(); };
  }

  /* favicon / manifest / theme-color — injected once per page (added only if absent). */
  function headIcons() {
    const head = document.head;
    if (!head) return;
    const add = (sel, html) => { if (!document.querySelector(sel)) head.insertAdjacentHTML('beforeend', html); };
    add('link[rel="icon"]', '<link rel="icon" type="image/png" sizes="32x32" href="/images/favicon-32.png">');
    add('link[rel="apple-touch-icon"]', '<link rel="apple-touch-icon" href="/images/apple-touch-icon.png">');
    add('link[rel="manifest"]', '<link rel="manifest" href="/site.webmanifest">');
    add('meta[name="theme-color"]', '<meta name="theme-color" content="#16181f">');
  }


  /* === Paw cursor (desktop only) — replaces the old ring on every page === */
  var CK_PAW='<svg viewBox="0 0 64 64"><g fill="#d2922f" stroke="#3d2a0e" stroke-width="3" stroke-linejoin="round"><ellipse cx="32" cy="43" rx="16" ry="14"/><ellipse cx="14" cy="27" rx="6.2" ry="8.4"/><ellipse cx="25" cy="18" rx="6.2" ry="9"/><ellipse cx="39" cy="18" rx="6.2" ry="9"/><ellipse cx="50" cy="27" rx="6.2" ry="8.4"/></g><ellipse cx="27" cy="38" rx="5.5" ry="4" fill="#f3d9a8" opacity=".55"/></svg>';
  function pawCursor(){
    if(!(window.matchMedia&&window.matchMedia('(hover:hover) and (pointer:fine)').matches))return;
    if(document.getElementById('ck-paw'))return;
    var p=document.createElement('div');p.id='ck-paw';p.setAttribute('aria-hidden','true');
    p.innerHTML='<div class="pawi">'+CK_PAW+'</div>';document.body.appendChild(p);
    document.documentElement.classList.add('ck-pawon');
    var tx=innerWidth/2,ty=innerHeight/2,cx=tx,cy=ty,shown=false;
    addEventListener('pointermove',function(e){tx=e.clientX;ty=e.clientY;if(!shown){shown=true;p.style.opacity=1;}var h=e.target.closest&&e.target.closest('a,button,input,select,textarea,[data-mag],.swatch,.card,.d');p.classList.toggle('hot',!!h);},{passive:true});
    addEventListener('pointerdown',function(){p.classList.add('press');});
    addEventListener('pointerup',function(){p.classList.remove('press');});
    document.addEventListener('mouseleave',function(){p.style.opacity=0;});
    document.addEventListener('mouseenter',function(){p.style.opacity=1;});
    window.addEventListener('focus',function(){p.style.opacity=1;});
    document.addEventListener('visibilitychange',function(){ if(!document.hidden) p.style.opacity=1; });
    (function loop(){cx+=(tx-cx)*0.25;cy+=(ty-cy)*0.25;p.style.transform='translate('+cx+'px,'+cy+'px) translate(-50%,-50%)';requestAnimationFrame(loop);})();
  }

  /* === Peekaboo password toggle — Coops & Fred, every password field === */
  var CK_DOGS=["<svg class=\"dogwrap\" viewBox=\"0 0 84 84\" aria-hidden=\"true\">\n <defs>\n  <radialGradient id=\"cH\" cx=\"50%\" cy=\"40%\" r=\"64%\"><stop offset=\"0\" stop-color=\"#f0d4a6\"/><stop offset=\"1\" stop-color=\"#d2aa72\"/></radialGradient>\n  <radialGradient id=\"cP\" cx=\"50%\" cy=\"35%\" r=\"70%\"><stop offset=\"0\" stop-color=\"#ecd0a2\"/><stop offset=\"1\" stop-color=\"#cba36e\"/></radialGradient>\n </defs>\n <g class=\"ears\" stroke=\"#33240f\" stroke-width=\"2.6\" stroke-linejoin=\"round\">\n  <path d=\"M28 31 Q14 27 16 8 Q29 9 34 30 Z\" fill=\"#d9b27e\"/><path d=\"M56 31 Q70 27 68 8 Q55 9 50 30 Z\" fill=\"#d9b27e\"/>\n  <path d=\"M27 27 Q19 24 20 12 Q28 14 31.5 27 Z\" fill=\"#e4a79f\" stroke=\"none\"/><path d=\"M57 27 Q65 24 64 12 Q56 14 52.5 27 Z\" fill=\"#e4a79f\" stroke=\"none\"/>\n  <path d=\"M26 26 Q21 24 21.5 16 Q26 18 29 26 Z\" fill=\"#c98279\" stroke=\"none\" opacity=\".6\"/><path d=\"M58 26 Q63 24 62.5 16 Q58 18 55 26 Z\" fill=\"#c98279\" stroke=\"none\" opacity=\".6\"/></g>\n <path d=\"M42 23 C62 23 64 42 62 54 C60 66 51 71 42 71 C33 71 24 66 22 54 C20 42 22 23 42 23 Z\" fill=\"url(#cH)\" stroke=\"#33240f\" stroke-width=\"2.8\"/>\n <path d=\"M42 26 Q47 33 42 38 Q37 33 42 26 Z\" fill=\"#c39c66\" opacity=\".5\"/>\n <ellipse cx=\"42\" cy=\"58\" rx=\"14\" ry=\"11\" fill=\"#f4e8cf\"/><ellipse cx=\"42\" cy=\"51.5\" rx=\"13\" ry=\"5\" fill=\"#d9bd92\" opacity=\".5\"/>\n <g><ellipse cx=\"33\" cy=\"45\" rx=\"5\" ry=\"5.6\" fill=\"#fbf7f0\" stroke=\"#33240f\" stroke-width=\"1.5\"/><circle cx=\"34\" cy=\"46\" r=\"4\" fill=\"#5b3a1d\"/><circle cx=\"34\" cy=\"46.4\" r=\"2.2\" fill=\"#211309\"/><circle cx=\"32.4\" cy=\"44\" r=\"1.3\" fill=\"#fff\"/>\n <ellipse cx=\"51\" cy=\"45\" rx=\"5\" ry=\"5.6\" fill=\"#fbf7f0\" stroke=\"#33240f\" stroke-width=\"1.5\"/><circle cx=\"50\" cy=\"46\" r=\"4\" fill=\"#5b3a1d\"/><circle cx=\"50\" cy=\"46.4\" r=\"2.2\" fill=\"#211309\"/><circle cx=\"48.4\" cy=\"44\" r=\"1.3\" fill=\"#fff\"/>\n <path d=\"M27 39 Q33 36 38 39\" fill=\"none\" stroke=\"#33240f\" stroke-width=\"1.6\" stroke-linecap=\"round\" opacity=\".7\"/><path d=\"M46 39 Q51 36 57 39\" fill=\"none\" stroke=\"#33240f\" stroke-width=\"1.6\" stroke-linecap=\"round\" opacity=\".7\"/></g>\n <path d=\"M36 56 Q42 51 48 56 Q46 62 42 62 Q38 62 36 56 Z\" fill=\"#241a12\"/><ellipse cx=\"39\" cy=\"55\" rx=\"1.4\" ry=\"1\" fill=\"#5a4a3a\"/>\n <path d=\"M42 62 V66 M42 66 Q37 69 33 66 M42 66 Q47 69 51 66\" fill=\"none\" stroke=\"#33240f\" stroke-width=\"1.7\" stroke-linecap=\"round\"/>\n <g class=\"paws\"  stroke=\"#33240f\" stroke-width=\"2.4\" stroke-linejoin=\"round\">\n  <g fill=\"url(#cP)\"><ellipse cx=\"33\" cy=\"43\" rx=\"10\" ry=\"8.4\"/><ellipse cx=\"27.5\" cy=\"36.5\" rx=\"2.7\" ry=\"3.6\" stroke=\"none\" fill=\"#c39b65\"/><ellipse cx=\"33\" cy=\"34.5\" rx=\"2.8\" ry=\"3.8\" stroke=\"none\" fill=\"#c39b65\"/><ellipse cx=\"38.5\" cy=\"36.5\" rx=\"2.7\" ry=\"3.6\" stroke=\"none\" fill=\"#c39b65\"/><ellipse cx=\"33\" cy=\"45\" rx=\"3.4\" ry=\"2.6\" stroke=\"none\" fill=\"#caa067\" opacity=\".7\"/></g>\n  <g fill=\"url(#cP)\"><ellipse cx=\"51\" cy=\"43\" rx=\"10\" ry=\"8.4\"/><ellipse cx=\"45.5\" cy=\"36.5\" rx=\"2.7\" ry=\"3.6\" stroke=\"none\" fill=\"#c39b65\"/><ellipse cx=\"51\" cy=\"34.5\" rx=\"2.8\" ry=\"3.8\" stroke=\"none\" fill=\"#c39b65\"/><ellipse cx=\"56.5\" cy=\"36.5\" rx=\"2.7\" ry=\"3.6\" stroke=\"none\" fill=\"#c39b65\"/><ellipse cx=\"51\" cy=\"45\" rx=\"3.4\" ry=\"2.6\" stroke=\"none\" fill=\"#caa067\" opacity=\".7\"/></g></g>\n </svg>","<svg class=\"dogwrap\" viewBox=\"0 0 84 84\" aria-hidden=\"true\">\n <defs><radialGradient id=\"fH\" cx=\"50%\" cy=\"40%\" r=\"64%\"><stop offset=\"0\" stop-color=\"#ad6c3c\"/><stop offset=\"1\" stop-color=\"#7c4a26\"/></radialGradient>\n  <radialGradient id=\"fP\" cx=\"50%\" cy=\"35%\" r=\"70%\"><stop offset=\"0\" stop-color=\"#a4663a\"/><stop offset=\"1\" stop-color=\"#74441f\"/></radialGradient></defs>\n <g class=\"ears\" stroke=\"#33240f\" stroke-width=\"2.6\" stroke-linejoin=\"round\"><path d=\"M27 30 Q11 28 11 48 Q25 46 31 33 Z\" fill=\"#6e4022\"/><path d=\"M57 30 Q73 28 73 48 Q59 46 53 33 Z\" fill=\"#6e4022\"/></g>\n <path d=\"M42 22 C62 22 65 40 63 53 C61 66 51 71 42 71 C33 71 23 66 21 53 C19 40 22 22 42 22 Z\" fill=\"url(#fH)\" stroke=\"#33240f\" stroke-width=\"2.8\"/>\n <path d=\"M37 23 Q42 18 47 23 Q46 45 42 52 Q38 45 37 23 Z\" fill=\"#f2ebdf\"/>\n <ellipse cx=\"42\" cy=\"59\" rx=\"15\" ry=\"11\" fill=\"#f2ebdf\"/>\n <path d=\"M23 47 Q27 31 35 35 Q32 47 29 53 Z\" fill=\"#5a3218\" opacity=\".55\"/><path d=\"M61 47 Q57 31 49 35 Q52 47 55 53 Z\" fill=\"#5a3218\" opacity=\".55\"/>\n <ellipse cx=\"42\" cy=\"46\" rx=\"20\" ry=\"13\" fill=\"#4a2a13\" opacity=\".28\"/>\n <g><ellipse cx=\"33\" cy=\"45\" rx=\"5.2\" ry=\"5.8\" fill=\"#fbf7f0\" stroke=\"#33240f\" stroke-width=\"1.5\"/><circle cx=\"34\" cy=\"46\" r=\"4.2\" fill=\"#4a2c14\"/><circle cx=\"34\" cy=\"46.4\" r=\"2.3\" fill=\"#1c1108\"/><circle cx=\"32.3\" cy=\"44\" r=\"1.4\" fill=\"#fff\"/>\n <ellipse cx=\"51\" cy=\"45\" rx=\"5.2\" ry=\"5.8\" fill=\"#fbf7f0\" stroke=\"#33240f\" stroke-width=\"1.5\"/><circle cx=\"50\" cy=\"46\" r=\"4.2\" fill=\"#4a2c14\"/><circle cx=\"50\" cy=\"46.4\" r=\"2.3\" fill=\"#1c1108\"/><circle cx=\"48.3\" cy=\"44\" r=\"1.4\" fill=\"#fff\"/></g>\n <path d=\"M35 55 Q42 50 49 55 Q47 61 42 61 Q37 61 35 55 Z\" fill=\"#1d150e\"/><ellipse cx=\"38.5\" cy=\"54\" rx=\"1.6\" ry=\"1.1\" fill=\"#5a4a3a\"/>\n <path d=\"M38 61 Q42 71 46 61 Z\" fill=\"#e87f97\" stroke=\"#33240f\" stroke-width=\"1.3\"/><path d=\"M42 63 v5\" stroke=\"#bb566c\" stroke-width=\"1\"/>\n <g class=\"paws\"  stroke=\"#33240f\" stroke-width=\"2.4\" stroke-linejoin=\"round\">\n  <g fill=\"url(#fP)\"><ellipse cx=\"33\" cy=\"43\" rx=\"10\" ry=\"8.4\"/><ellipse cx=\"27.5\" cy=\"36.5\" rx=\"2.7\" ry=\"3.6\" stroke=\"none\" fill=\"#6e4022\"/><ellipse cx=\"33\" cy=\"34.5\" rx=\"2.8\" ry=\"3.8\" stroke=\"none\" fill=\"#6e4022\"/><ellipse cx=\"38.5\" cy=\"36.5\" rx=\"2.7\" ry=\"3.6\" stroke=\"none\" fill=\"#6e4022\"/></g>\n  <g fill=\"url(#fP)\"><ellipse cx=\"51\" cy=\"43\" rx=\"10\" ry=\"8.4\"/><ellipse cx=\"45.5\" cy=\"36.5\" rx=\"2.7\" ry=\"3.6\" stroke=\"none\" fill=\"#6e4022\"/><ellipse cx=\"51\" cy=\"34.5\" rx=\"2.8\" ry=\"3.8\" stroke=\"none\" fill=\"#6e4022\"/><ellipse cx=\"56.5\" cy=\"36.5\" rx=\"2.7\" ry=\"3.6\" stroke=\"none\" fill=\"#6e4022\"/></g></g>\n </svg>"];
  function pwPeekaboo(){
    var dogs=CK_DOGS,i=0;
    document.querySelectorAll('input[type="password"]:not([data-pk])').forEach(function(inp){
      inp.setAttribute('data-pk','1');
      var wrap=document.createElement('span');wrap.className='ck-pw';
      inp.parentNode.insertBefore(wrap,inp);wrap.appendChild(inp);
      var b=document.createElement('button');b.type='button';b.className='ck-peek';b.setAttribute('aria-label','Show password');
      b.innerHTML=dogs[i++%2];
      b.addEventListener('click',function(){var show=inp.type==='password';inp.type=show?'text':'password';b.classList.toggle('show',show);b.setAttribute('aria-label',show?'Hide password':'Show password');});
      wrap.appendChild(b);
    });
  }

  /* === Cloudflare Web Analytics (public beacon token; safe in page source) === */
  function analyticsBeacon(){
    if(document.getElementById('cf-beacon'))return;
    var s=document.createElement('script');
    s.id='cf-beacon'; s.defer=true;
    s.src='https://static.cloudflareinsights.com/beacon.min.js';
    s.setAttribute('data-cf-beacon','{"token":"3d05059af2c546739d8f8ab1788174a3"}');
    document.body.appendChild(s);
  }

  function mountChrome(active) {
    headIcons();
    document.body.insertAdjacentHTML('afterbegin', header(active));
    document.body.insertAdjacentHTML('beforeend', footer());
    renderCount();
    cookieNotice();
    motionChrome();
    pawCursor();
    pwPeekaboo();
    analyticsBeacon();
  }

  const money = gbp; // format a number already in the active currency
  return { load, params, gbp, money, unit, lineTotal, getBasket, saveBasket, addToBasket, removeFromBasket, basketTotal, basketCount, renderCount, designImg, reveals, mountChrome };
})();
