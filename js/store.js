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

  /* ── scroll reveal ── */
  function reveals() {
    const io = new IntersectionObserver(es => es.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }), { threshold: .08 });
    document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  }

  /* ── shared chrome ── */
  function header(active) {
    return `
    <header class="site-header"><div class="wrap">
      <a class="logo" href="index.html"><span class="paw">🐾</span> Canine Keepsakes</a>
      <nav class="nav">
        <a href="index.html#collections" ${active==='collections'?'style="opacity:1"':''}>Collections</a>
        <a href="index.html#how">How it works</a>
        <a href="account.html" ${active==='account'?'style="opacity:1"':''}>Account</a>
        <a class="basket-btn" href="basket.html">Basket <span class="basket-count">0</span></a>
      </nav>
    </div></header>`;
  }
  function footer() {
    const y = new Date().getFullYear();
    return `
    <footer class="site-footer"><div class="wrap">
      <div>
        <div style="font-family:var(--font-display);font-size:1.2rem;font-weight:700;margin-bottom:8px">Canine Keepsakes</div>
        <div class="muted">Premium gifts for dog people. Printed &amp; shipped in the UK.</div>
      </div>
      <div class="muted">© ${y} Canine Keepsakes · UK delivery only (for now)</div>
    </div></footer>`;
  }
  function mountChrome(active) {
    document.body.insertAdjacentHTML('afterbegin', header(active));
    document.body.insertAdjacentHTML('beforeend', footer());
    renderCount();
  }

  return { load, params, gbp, getBasket, saveBasket, addToBasket, removeFromBasket, basketTotal, basketCount, renderCount, designImg, reveals, mountChrome };
})();
