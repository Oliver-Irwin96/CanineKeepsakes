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
  const gbp = n => '£' + n.toFixed(2);

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
  const basketTotal = () => getBasket().reduce((s, x) => s + x.price * x.qty, 0);
  const basketCount = () => getBasket().reduce((s, x) => s + x.qty, 0);

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
      <a class="logo" href="index.html"><span class="paw">🐾</span> Canine Keepsakes</a>
      <nav class="nav">
        <a href="index.html#collections" ${active==='collections'?'style="opacity:1"':''}>Collections</a>
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
          <div class="foot-title">Canine Keepsakes</div>
          <div class="muted">Original dog artwork for people who are properly obsessed with their dogs. Designed as collections, personalised by breed, printed to order.</div>
        </div>
        <div class="foot-col">
          <h4>Shop</h4>
          <a href="index.html#collections">Collections</a>
          <a href="submit-design.html">Custom Dog Art</a>
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
    add('link[rel="icon"]', '<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
    add('link[rel="apple-touch-icon"]', '<link rel="apple-touch-icon" href="/favicon.svg">');
    add('link[rel="manifest"]', '<link rel="manifest" href="/site.webmanifest">');
    add('meta[name="theme-color"]', '<meta name="theme-color" content="#16181f">');
  }

  function mountChrome(active) {
    headIcons();
    document.body.insertAdjacentHTML('afterbegin', header(active));
    document.body.insertAdjacentHTML('beforeend', footer());
    renderCount();
    cookieNotice();
    motionChrome();
  }

  return { load, params, gbp, getBasket, saveBasket, addToBasket, removeFromBasket, basketTotal, basketCount, renderCount, designImg, reveals, mountChrome };
})();
