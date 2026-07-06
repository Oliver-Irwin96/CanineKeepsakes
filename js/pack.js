/* Canine Keepsakes — My Pack (breed memory)
   NEW FILE — adds behaviour, changes nothing existing (per guardrails §0).
   localStorage-first; optional account sync only succeeds if profiles.pack
   column exists (see _deploy-candidates/README.md), fails silently otherwise.
   All user-facing copy that consumes this = placeholder pending copy review. */
const CKPack = (() => {
  const KEY = 'ck-pack-v1';
  const def = () => ({ dogs: [], active: -1, gift: false });
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || def(); } catch { return def(); } };
  let state = read();
  const listeners = [];
  function emit(){ listeners.forEach(f => { try { f(state); } catch (_) {} }); }
  function save(){ try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {} emit(); syncUp(); }

  function dog(){ return (!state.gift && state.active >= 0 && state.dogs[state.active]) || null; }
  function breed(){ const d = dog(); return d ? d.breed : null; }
  function add(name, breedName){
    state.dogs.push({ name: String(name || 'Your pup').slice(0, 40), breed: String(breedName || '') });
    state.active = state.dogs.length - 1; state.gift = false; save();
  }
  function update(i, fields){ if (state.dogs[i]) { Object.assign(state.dogs[i], fields); save(); } }
  function remove(i){ state.dogs.splice(i, 1); if (state.active >= state.dogs.length) state.active = state.dogs.length - 1; save(); }
  function setActive(i){ if (state.dogs[i]) { state.active = i; state.gift = false; save(); } }
  function setGift(on){ state.gift = !!on; save(); }
  function reset(){ state = def(); save(); }
  /* breed confirmer quick-path: remember a breed without the full add-a-dog flow */
  function quickSet(breedName){
    if (!breedName) return;
    state.gift = false;
    if (dog()) state.dogs[state.active].breed = breedName; else add('Your pup', breedName);
    save();
  }
  function onChange(f){ listeners.push(f); }

  /* ── optional account sync (additive; requires profiles.pack column) ── */
  let syncT = null;
  function syncUp(){
    if (!(window.CK && CK.auth)) return;
    clearTimeout(syncT);
    syncT = setTimeout(async () => {
      try { const u = await CK.auth.user(); if (u) await CK.auth.saveProfile({ pack: JSON.stringify(state) }); } catch (_) {}
    }, 800);
  }
  async function syncDown(){
    if (!(window.CK && CK.auth)) return;
    try {
      const p = await CK.auth.profile();
      if (p && p.pack) {
        const remote = JSON.parse(p.pack);
        if (remote && Array.isArray(remote.dogs) && remote.dogs.length && !state.dogs.length) {
          state = remote;
          try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) {}
          emit();
        }
      }
    } catch (_) {}
  }
  return { get state(){ return state; }, dog, breed, add, update, remove, setActive, setGift, reset, quickSet, onChange, syncDown };
})();
