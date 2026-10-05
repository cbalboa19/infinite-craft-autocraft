// Auto-Craft v7 for Infinite Craft (https://neal.fun/infinite-craft/)
// https://github.com/cbalboa19/infinite-craft-autocraft
//
// Usage: open the game, press F12 > Console, paste this whole file and press Enter.
// It drives the game's own engine, so everything is saved to your save file.
// You can paste it again at any time: it replaces the running copy without losing anything.
//
// The idea: neal.fun rate-limits requests, so the only way to get more out of it
// is to make every request count. To do that:
//
//  - 🧠 A model learns live to predict whether a pair will produce something new
//    (online logistic regression over 17 features: each element's track record,
//    generation, age, name length, shared words, "Nothing" rate, 🏆 produced…).
//    Every turn seven strategies propose ~140 candidates and the model picks the
//    best one, with some randomness so it keeps learning (Boltzmann exploration
//    plus 4% uniformly random picks).
//    It has two heads: one predicts "new" and the other "🏆 first discovery".
//    The panel shows its predictions next to what actually happens.
//  - Strategies that propose candidates:
//      basic    = fresh + Water/Fire/Wind/Earth
//      fresh    = fresh + fresh            mixed  = fresh + anything
//      recent   = latest discovery + something      double = X + X
//      rare     = your 🏆 with each other           target = closest to what you search
//  - 🔎 Search for an element: type a word and the model leans towards elements with
//    similar names. It stops when it finds it. This is a heuristic: the game gives
//    no way to know a result before asking for it.
//  - Pairs that return "Nothing" count as tries, so sterile elements stop looking
//    promising.
//  - "Nothing" pairs are stored in IndexedDB (no 5 MB localStorage limit) and are
//    migrated automatically from older versions.
//  - A cross-tab lock stops two tabs from crafting at once and getting you blocked.
//  - Keeps full speed in a background tab (timer in a Web Worker: Chrome throttles
//    setTimeout in hidden tabs).
//  - AIMD pacing: after a block the cap drops to 70% and climbs back 0.5/s every
//    20 min without blocks. Honours Retry-After. Exponential backoff on errors.
//  - Draggable, collapsible panel, dark mode, 30-minute chart, log filter, sound and
//    tab-title alert on 🏆, auto-stop, and export of your 🏆. Remembers settings,
//    model and totals across reloads.
//  - Shortcuts: Alt+P pause/resume · Alt+M collapse the panel.
//
// From the console: autoCraft.pause(), .resume(), .setPace(4), .setGoal('first'),
// .setTarget('Dragon'), .stopAfter({ minutes: 30, items: 100, firsts: 5 }),
// .exportFirsts(), .stats(), .resetLearning(), .resetPaceCap(), .forgetNothing(), .destroy()
(async () => {
  'use strict';
  if (!window.IC || !window.IC.craft) {
    alert('Open https://neal.fun/infinite-craft/ before running this script.');
    return;
  }
  const prev = window.autoCraft;
  const wasRunning = prev && prev.state ? prev.state.running : true;
  if (prev && prev.destroy) prev.destroy();

  const VERSION = 'v7';
  const WORKERS = 6;                    // max requests in flight
  const PACE_MIN = 1;
  const PACE_MAX = 5;
  const CAP_RECOVERY_MS = 20 * 60000;   // raise the cap 0.5/s after this long without blocks
  const CRAFT_TIMEOUT_MS = 30000;
  const DECAY = 0.997;                  // forgetting factor for per-strategy stats
  const RECENT_MAX = 60;
  const LOG_MAX = 300;
  const PER_GEN = 20;                   // candidates per strategy per pick
  const TEMP = 0.35;                    // temperature: lower = greedier
  const EPSILON = 0.04;                 // share of uniformly random picks
  const LR = 0.03;                      // model learning rate
  const L2 = 1e-3;                      // pull back towards the initial weights
  const TARGET_BOOST = 3;               // weight of similarity to the search target
  const CALIB_MAX = 300;
  const STARTERS = new Set(['Water', 'Fire', 'Wind', 'Earth']);
  const SAVE = String(IC.getCurrentSave ? IC.getCurrentSave() : 0);
  const KEYS = {
    settings: 'autocraft-settings',
    cap: 'autocraft-pace-cap',
    nothing: 'autocraft-nothing-' + SAVE,   // legacy format (localStorage)
    stats: 'autocraft-stats-' + SAVE,
    model: 'autocraft-model',
  };

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const rnd = (n) => Math.floor(Math.random() * n);
  const pickOne = (arr) => arr[rnd(arr.length)];
  const inc = (map, k, by = 1) => map.set(k, (map.get(k) || 0) + by);
  const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  const sigmoid = (z) => 1 / (1 + Math.exp(-clamp(z, -30, 30)));
  const pct = (x) => (x < 0.1 ? (100 * x).toFixed(1) : Math.round(100 * x)) + '%';
  const load = (key, def) => {
    try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
  };
  const store = (key, val) => {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; }
  };
  const fmtTime = (ms) => {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
  };

  // ---------- Timer that survives hidden tabs ----------
  // Chrome limits setTimeout in a hidden tab to once a minute after 5 minutes;
  // a Web Worker's timers are not limited. Falls back to setTimeout if needed.
  let timerWorker = null;
  const timerCbs = new Map();
  let timerSeq = 0;
  try {
    const url = URL.createObjectURL(new Blob(
      ['onmessage=e=>setTimeout(()=>postMessage(e.data[0]),e.data[1])'], { type: 'text/javascript' }));
    timerWorker = new Worker(url);
    URL.revokeObjectURL(url);
    timerWorker.onmessage = (e) => {
      const cb = timerCbs.get(e.data);
      timerCbs.delete(e.data);
      if (cb) cb();
    };
    timerWorker.onerror = () => {
      timerWorker = null;
      for (const cb of timerCbs.values()) setTimeout(cb, 0);
      timerCbs.clear();
    };
  } catch (e) { timerWorker = null; }
  const sleep = (ms) => new Promise((resolve) => {
    if (timerWorker && ms > 0) {
      const id = ++timerSeq;
      timerCbs.set(id, resolve);
      timerWorker.postMessage([id, ms]);
    } else setTimeout(resolve, ms);
  });
  const every = (ms, fn) => {   // an interval that is not throttled either
    let alive = true;
    (async () => { while (alive) { await sleep(ms); if (alive) try { fn(); } catch (e) { console.warn('[autocraft]', e); } } })();
    return () => { alive = false; };
  };

  // ---------- Settings and state ----------
  const settings = Object.assign(
    { pace: 2, goal: 'new', onlyHits: true, sound: true, collapsed: false, pos: null, target: '' },
    load(KEYS.settings, {}));
  const saveSettings = () => store(KEYS.settings, settings);

  const state = {
    running: wasRunning,
    destroyed: false,
    desired: clamp(+settings.pace || 2, PACE_MIN, PACE_MAX),   // what the user asked for
    paceCap: clamp(+load(KEYS.cap, PACE_MAX) || PACE_MAX, PACE_MIN, PACE_MAX),
    get pace() { return Math.min(this.desired, this.paceCap); },
    goal: settings.goal === 'first' ? 'first' : 'new',
    target: '',
    closest: null,   // { text, emoji, sim } closest element to the search target
    combos: 0, newItems: 0, firsts: 0, nothing: 0, repeats: 0, errors: 0, blocks: 0,
    latency: 0,      // moving average of response time (ms)
    startedAt: Date.now(),
    activeMs: 0,
    stop: null,      // { until, items, firsts } measured over this session
  };
  const saved = load(KEYS.stats, {});
  const lifetime = Object.assign({ combos: 0, newItems: 0, firsts: 0, nothing: 0 }, saved.lifetime);

  // Per-strategy stats: informational only (the model makes the decisions).
  // Internal ids are kept from earlier versions so saved stats carry over.
  const STRATS = {
    basico: 'basic', fresco: 'fresh', mixto: 'mixed', reciente: 'recent',
    doble: 'double', raro: 'rare', objetivo: 'target',
  };
  const strategies = {};
  function initStrategies(from) {
    for (const [id, label] of Object.entries(STRATS)) {
      const s = from && from[id];
      strategies[id] = s && s.tries > 0
        ? { label, tries: s.tries, wNew: s.wNew, wFirst: s.wFirst, used: 0 }
        : { label, tries: 6, wNew: 2, wFirst: 0.3, used: 0 };
    }
  }
  initStrategies(saved.strategies);
  const winsOf = (s) => (state.goal === 'first' ? s.wFirst : s.wNew);
  function rewardStrategy(id, gaveNew, gaveFirst) {
    for (const s of Object.values(strategies)) { s.tries *= DECAY; s.wNew *= DECAY; s.wFirst *= DECAY; }
    const s = strategies[id];
    s.tries++;
    s.used++;
    if (gaveNew) s.wNew++;
    if (gaveFirst) s.wFirst++;
  }

  // ---------- Model ----------
  // Online logistic regression: p = sigmoid(w · x). After every server response
  // w is nudged a little in the direction that would have been right.
  const FEATURES = [
    'bias', 'mean hit rate', 'min hit rate', 'times tried', 'X + X', 'starters', '🏆 involved',
    'recency', 'generation', 'generation gap', 'name length', 'word count', 'shared words',
    'one name contains the other', 'Nothing rate', '🏆 produced', 'same emoji',
  ];
  const D = FEATURES.length;
  // Sensible starting weights so it works well from the first minute.
  const PRIOR_NEW = [-0.4, 0.9, 0.3, -0.3, 0.2, -0.4, 0.1, 0.4, 0.2, 0, 0.1, 0.1, -0.8, -0.6, -1.0, 0.1, -0.2];
  const PRIOR_FIRST = [-3.5, 0.3, 0.1, -0.2, 0, -0.8, 0.8, 0.3, 0.4, 0, 0.4, 0.3, -0.5, -0.4, -0.5, 0.6, 0];
  const savedModel = load(KEYS.model, null);
  const okModel = savedModel && savedModel.d === D && Array.isArray(savedModel.wNew);
  const model = {
    new: { w: Float64Array.from(okModel ? savedModel.wNew : PRIOR_NEW), prior: PRIOR_NEW },
    first: { w: Float64Array.from(okModel ? savedModel.wFirst : PRIOR_FIRST), prior: PRIOR_FIRST },
    lessons: okModel ? savedModel.lessons || 0 : 0,
  };
  const calib = [];   // [predicted p, outcome, mean p of the candidates]
  const dot = (w, x) => { let s = 0; for (let i = 0; i < D; i++) s += w[i] * x[i]; return s; };
  function learn(head, x, y) {
    const err = sigmoid(dot(head.w, x)) - y;
    for (let i = 0; i < D; i++) head.w[i] -= LR * (err * x[i] + L2 * (head.w[i] - head.prior[i]));
  }
  function resetModel() {
    model.new.w = Float64Array.from(PRIOR_NEW);
    model.first.w = Float64Array.from(PRIOR_FIRST);
    model.lessons = 0;
    calib.length = 0;
  }

  const persistStats = () => {
    const strats = {};
    for (const [id, s] of Object.entries(strategies)) strats[id] = { tries: s.tries, wNew: s.wNew, wFirst: s.wFirst };
    store(KEYS.stats, { lifetime, strategies: strats });
    store(KEYS.model, { d: D, wNew: [...model.new.w], wFirst: [...model.first.w], lessons: model.lessons });
  };

  // ---------- Game engine ----------
  // The main component returns {instance, isNew}, which stays reliable with several
  // crafts in flight. If it cannot be found, IC.craft is used instead.
  let game = null;
  (function walk(vm) {
    if (!vm || game) return;
    if (vm.$data && Array.isArray(vm.$data.items) && typeof vm.craft === 'function') { game = vm; return; }
    (vm.$children || []).forEach(walk);
  })(window.$nuxt);
  const claimed = new Set(IC.getItems().map((i) => i.text));
  async function rawCraft(a, b) {
    if (game) {
      const r = await game.craft(
        { text: a.text, emoji: a.emoji, itemId: a.id },
        { text: b.text, emoji: b.emoji, itemId: b.id });
      return r && r.instance ? { item: r.instance, isNew: !!r.isNew } : null;
    }
    const item = await IC.craft(a.text, b.text);
    if (!item) return null;
    const isNew = !claimed.has(item.text);
    claimed.add(item.text);
    return { item, isNew };
  }
  const craft = (a, b) => Promise.race([
    rawCraft(a, b),
    sleep(CRAFT_TIMEOUT_MS).then(() => { throw new Error('timeout'); }),
  ]);

  // ---------- Memory ----------
  const tried = new Set();      // pairs already tried ("A|B")
  const inFlight = new Set();   // pairs requested but not answered yet
  const tries = new Map();      // element -> pairs tried with it
  const news = new Map();       // element -> new elements it produced
  const firstsBy = new Map();   // element -> 🏆 it produced
  const nothingBy = new Map();  // element -> times it produced "Nothing"
  const order = new Map();      // element -> discovery position
  const depth = new Map();      // element -> generation (starters = 0)
  const errorsByPair = new Map();
  const recent = [];            // latest discoveries (text)
  const rare = new Set();       // your first discoveries (text)
  let nItems = 1;
  const score = (t) => {
    const gain = (news.get(t) || 0) + (state.goal === 'first' ? 4 * (firstsBy.get(t) || 0) : 0);
    return (gain + 1) / ((tries.get(t) || 0) + 2);
  };

  function record(a, b, gaveNew, gaveFirst) {
    const k = pairKey(a, b);
    if (tried.has(k)) return;
    tried.add(k);
    inc(tries, a);
    if (b !== a) inc(tries, b);
    if (gaveNew) { inc(news, a); if (b !== a) inc(news, b); }
    if (gaveFirst) { inc(firstsBy, a); if (b !== a) inc(firstsBy, b); }
  }
  function recordNothing(a, b) {
    if (tried.has(pairKey(a, b))) return;
    record(a, b, false, false);
    inc(nothingBy, a);
    if (b !== a) inc(nothingBy, b);
  }

  // ---------- "Nothing" pairs in IndexedDB ----------
  // The game does not store pairs that return "Nothing", so they are stored here
  // to never repeat them. IndexedDB has no 5 MB limit like localStorage.
  const nothingPairs = new Set();
  const nothingQueue = [];
  const NPREFIX = SAVE + '\u0001';
  let db = null;
  let migrating = false;
  let nothingDirty = false;   // only used without IndexedDB
  const idbReq = (req) => new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  async function loadNothing() {
    try {
      const open = indexedDB.open('autocraft', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('nothing');
      open.onblocked = () => {};
      db = await idbReq(open);
      if (db) {
        const keys = await idbReq(db.transaction('nothing').objectStore('nothing')
          .getAllKeys(IDBKeyRange.bound(NPREFIX, NPREFIX + '￿')));
        for (const key of keys || []) nothingPairs.add(key.slice(NPREFIX.length));
      }
    } catch (e) { db = null; }
    const legacy = load(KEYS.nothing, null);
    if (Array.isArray(legacy)) {
      for (const k of legacy) {
        if (nothingPairs.has(k)) continue;
        nothingPairs.add(k);
        if (db) nothingQueue.push(k);
      }
      if (db) migrating = true;
    }
    for (const k of nothingPairs) {
      const parts = k.split('|');
      if (parts.length === 2) recordNothing(parts[0], parts[1]);
    }
  }
  function addNothing(k) {
    nothingPairs.add(k);
    if (db) nothingQueue.push(k); else nothingDirty = true;
  }
  function saveNothing() {
    if (db) {
      if (!nothingQueue.length) return;
      const batch = nothingQueue.splice(0);
      try {
        const tx = db.transaction('nothing', 'readwrite');
        const st = tx.objectStore('nothing');
        for (const k of batch) st.put(1, NPREFIX + k);
        tx.oncomplete = () => {
          if (!migrating) return;
          migrating = false;
          try { localStorage.removeItem(KEYS.nothing); } catch (e) {}
        };
        tx.onerror = () => nothingQueue.push(...batch);
      } catch (e) { nothingQueue.push(...batch); }
      return;
    }
    if (!nothingDirty) return;
    nothingDirty = false;
    let list = [...nothingPairs];
    // If localStorage fills up, keep the most recent ones.
    while (list.length && !store(KEYS.nothing, list)) list = list.slice(Math.floor(list.length / 4));
  }
  function forgetNothing() {
    nothingPairs.clear();
    nothingQueue.length = 0;
    try { localStorage.removeItem(KEYS.nothing); } catch (e) {}
    if (db) {
      try {
        db.transaction('nothing', 'readwrite').objectStore('nothing')
          .delete(IDBKeyRange.bound(NPREFIX, NPREFIX + '￿'));
      } catch (e) {}
    }
  }
  const isTaken = (a, b) => {
    const k = pairKey(a, b);
    return tried.has(k) || nothingPairs.has(k) || inFlight.has(k);
  };

  // Reads the game history. Every element keeps the pairs that produce it; the
  // first one is the pair that discovered it. Only new recipes are processed.
  const idText = new Map();
  const seenRecipes = new Map();   // id -> recipes already read
  function syncHistory() {
    const items = IC.getItems();
    items.forEach((it, i) => {
      idText.set(it.id, it.text);
      if (!order.has(it.text)) order.set(it.text, i);
    });
    for (const it of items) {
      claimed.add(it.text);
      if (it.discovery) rare.add(it.text);
      const recipes = it.recipes || [];
      if (!depth.has(it.text)) {
        const a = recipes.length && idText.get(recipes[0][0]);
        const b = recipes.length && idText.get(recipes[0][1]);
        depth.set(it.text, STARTERS.has(it.text) || !a || !b
          ? 0 : 1 + Math.max(depth.get(a) || 0, depth.get(b) || 0));
      }
      const from = seenRecipes.get(it.id) || 0;
      if (recipes.length === from) continue;
      for (let idx = from; idx < recipes.length; idx++) {
        const a = idText.get(recipes[idx][0]);
        const b = idText.get(recipes[idx][1]);
        const isOrigin = idx === 0 && !STARTERS.has(it.text);
        if (a && b) record(a, b, isOrigin, isOrigin && !!it.discovery);
      }
      seenRecipes.set(it.id, recipes.length);
    }
    return items;
  }

  // The game returns null both for "Nothing" and for a server error. To tell them
  // apart (and to know whether it is a first discovery) the API response is read
  // without being modified.
  const pending = new Map();   // pair -> Promise<{kind, result?, first?, retryAfter?}>
  const origFetch = window.fetch;
  const wrappedFetch = function (input) {
    const p = origFetch.apply(this, arguments);
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.pathname.endsWith('/infinite-craft/pair')) {
        const k = pairKey(url.searchParams.get('first'), url.searchParams.get('second'));
        if (pending.size > 200) for (const key of pending.keys()) if (!inFlight.has(key)) pending.delete(key);
        pending.set(k, p
          .then((r) => {
            if (r.status === 429 || r.status === 403) {
              return { kind: 'ratelimit', retryAfter: +r.headers.get('retry-after') || 0 };
            }
            if (!r.ok) return { kind: 'error' };
            return r.clone().json().then((j) => {
              const result = String(j.result || '').trim();
              return result && result !== 'Nothing'
                ? { kind: 'ok', result, first: !!j.isNew }
                : { kind: 'nothing' };
            });
          })
          .catch(() => ({ kind: 'error' })));
      }
    } catch (e) {}
    return p;
  };
  window.fetch = wrappedFetch;

  // ---------- One tab at a time ----------
  // Two tabs crafting double the rate and cause blocks. With Web Locks only one
  // works; the others wait and take over if the first one is closed.
  let hasLock = !(navigator.locks && navigator.locks.request);
  let releaseLock = null;
  const lockAsked = Date.now();
  if (!hasLock) {
    navigator.locks.request('autocraft-runner', () => new Promise((resolve) => {
      if (state.destroyed) { resolve(); return; }
      hasLock = true;
      releaseLock = resolve;
    })).catch(() => { hasLock = true; });
  }

  // ---------- Pacing ----------
  // Hands out turns spaced 1/pace seconds apart across all workers.
  let nextSlot = 0;
  let cooldownUntil = 0;   // no worker sends anything until then
  let blockedUntil = 0;    // the part of that wait caused by a block
  let okSinceBlock = 0;
  let lastCapChange = Date.now();
  let errorStreak = 0;
  let ready = false;       // becomes true once memory has loaded
  async function takeSlot() {
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + 1000 / state.pace;
    if (slot > now) await sleep(slot - now);
  }
  const canWork = () => ready && hasLock && state.running && !state.destroyed && Date.now() >= cooldownUntil;
  const saveCap = () => store(KEYS.cap, state.paceCap);

  function onRateLimited(retryAfter) {
    if (Date.now() < blockedUntil) return;   // already waiting
    state.blocks++;
    okSinceBlock = 0;
    const backoff = Math.min(60000 * 2 ** (state.blocks - 1), 15 * 60000);
    const wait = retryAfter > 0 ? clamp(retryAfter * 1000, 30000, 30 * 60000) : backoff;
    cooldownUntil = blockedUntil = Date.now() + wait;
    state.paceCap = Math.max(PACE_MIN, Math.floor(state.pace * 0.7 * 2) / 2);
    lastCapChange = Date.now();
    saveCap();
    syncPaceInput();
  }
  function recoverCap() {
    if (state.paceCap >= PACE_MAX || !state.running || Date.now() < blockedUntil) return;
    if (Date.now() - lastCapChange < CAP_RECOVERY_MS) return;
    state.paceCap = Math.min(PACE_MAX, state.paceCap + 0.5);
    lastCapChange = Date.now();
    saveCap();
    syncPaceInput();
  }

  // ---------- Pair features ----------
  const tokenCache = new Map();
  function tokens(t) {
    let x = tokenCache.get(t);
    if (!x) {
      const words = t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      x = { set: new Set(words), wc: words.length || 1, len: t.length || 1, low: t.toLowerCase(), tri: null };
      tokenCache.set(t, x);
    }
    return x;
  }
  function itemStat(it) {
    const t = it.text;
    const tr = tries.get(t) || 0;
    const nw = news.get(t) || 0;
    const o = order.get(t);
    return {
      t,
      h: Math.log((nw + 1) / (tr - nw + 1)),
      lt: Math.log1p(tr),
      nr: ((nothingBy.get(t) || 0) + 0.3) / (tr + 2),
      fb: firstsBy.get(t) || 0,
      rec: o == null ? 1 : Math.min(1, o / nItems),
      dep: depth.get(t) || 0,
      starter: STARTERS.has(t) ? 1 : 0,
      rare: rare.has(t) ? 1 : 0,
      tok: tokens(t),
      emoji: it.emoji,
    };
  }
  function features(a, b) {
    const self = a.text === b.text;
    const A = itemStat(a);
    const B = self ? A : itemStat(b);
    let inter = 0;
    for (const w of A.tok.set) if (B.tok.set.has(w)) inter++;
    const uni = A.tok.set.size + B.tok.set.size - inter;
    const contain = !self && (A.tok.low.includes(B.tok.low) || B.tok.low.includes(A.tok.low)) ? 1 : 0;
    return [
      1,
      (A.h + B.h) / 2,
      Math.min(A.h, B.h),
      (A.lt + B.lt) / 6,
      self ? 1 : 0,
      (A.starter + B.starter) / 2,
      (A.rare + B.rare) / 2,
      (A.rec + B.rec) / 2,
      Math.min(A.dep + B.dep, 40) / 20,
      Math.min(Math.abs(A.dep - B.dep), 20) / 10,
      (Math.log(A.tok.len) + Math.log(B.tok.len)) / 6,
      Math.min(A.tok.wc + B.tok.wc, 12) / 4,
      self || !uni ? 0 : inter / uni,
      contain,
      (A.nr + B.nr) / 2,
      Math.log1p(A.fb + B.fb),
      !self && A.emoji && A.emoji === B.emoji ? 1 : 0,
    ];
  }

  // ---------- Searching for a specific element ----------
  // Similarity by letter trigrams (Dice coefficient): "Dragon" ~ "Dragonfly".
  function trigrams(s) {
    s = ' ' + s.toLowerCase() + ' ';
    const set = new Set();
    for (let i = 0; i < s.length - 2; i++) set.add(s.slice(i, i + 3));
    return set;
  }
  let targetTri = null;
  function simToTarget(t) {
    if (!targetTri) return 0;
    const x = tokens(t);
    if (!x.tri) x.tri = trigrams(t);
    let inter = 0;
    for (const g of x.tri) if (targetTri.has(g)) inter++;
    return (2 * inter) / (x.tri.size + targetTri.size);
  }
  function noteClosest(it) {
    if (!targetTri) return;
    const sim = simToTarget(it.text);
    if (sim > 0 && (!state.closest || sim > state.closest.sim)) state.closest = { text: it.text, emoji: it.emoji, sim };
  }

  // ---------- Choosing a pair ----------
  let pool = null;   // visible elements, recomputed at most once a second
  let poolAt = 0;
  function getPool() {
    const now = Date.now();
    if (pool && now - poolAt < 1000) return pool;
    const items = IC.getItems().filter((i) => !i.hidden);
    const byText = new Map(items.map((i) => [i.text, i]));
    let near = [];
    if (targetTri) {
      near = items.map((i) => [i, simToTarget(i.text)]).sort((x, y) => y[1] - x[1]).slice(0, 40).map((x) => x[0]);
    }
    pool = {
      items,
      byText,
      near,
      starters: items.filter((i) => STARTERS.has(i.text)),
      rare: [...rare].map((t) => byText.get(t)).filter(Boolean),
    };
    poolAt = now;
    nItems = Math.max(1, items.length);
    return pool;
  }

  function evaluate(c) {
    c.x = features(c.a, c.b);
    c.pNew = sigmoid(dot(model.new.w, c.x));
    c.pFirst = sigmoid(dot(model.first.w, c.x));
    const u = state.goal === 'first' ? 4 * c.pFirst + 0.25 * c.pNew : c.pNew + 0.5 * c.pFirst;
    c.z = Math.log(u + 1e-9);
    if (targetTri) c.z += TARGET_BOOST * Math.max(simToTarget(c.a.text), simToTarget(c.b.text));
    return c;
  }

  function pickPair() {
    const { items, byText, starters, rare: rareItems, near } = getPool();
    const n = items.length;
    if (!n) return null;

    // Weighted draw (weight = score²) to propose elements that pay off.
    const cum = new Float64Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const t = items[i].text;
      total += (tries.get(t) || 0) < n ? score(t) ** 2 : 0;
      cum[i] = total;
    }
    const any = () => items[rnd(n)];
    const draw = total > 0 ? () => {
      const r = Math.random() * total;
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < r) lo = mid + 1; else hi = mid;
      }
      return items[lo];
    } : any;
    const recentItems = recent.map((t) => byText.get(t)).filter(Boolean);
    const gens = {
      basico: starters.length ? () => [draw(), pickOne(starters)] : null,
      fresco: () => [draw(), draw()],
      mixto: () => [draw(), any()],
      reciente: recentItems.length ? () => [pickOne(recentItems), Math.random() < 0.5 ? draw() : any()] : null,
      doble: () => { const a = draw(); return [a, a]; },
      raro: rareItems.length ? () => [pickOne(rareItems), Math.random() < 0.5 ? pickOne(rareItems) : draw()] : null,
      objetivo: near.length ? () => [pickOne(near), Math.random() < 0.5 ? pickOne(near) : draw()] : null,
    };

    // 1) Each strategy proposes up to PER_GEN untried pairs.
    const cands = [];
    const seen = new Set();
    for (const [name, gen] of Object.entries(gens)) {
      if (!gen) continue;
      let got = 0;
      for (let t = 0; t < PER_GEN * 2 && got < PER_GEN; t++) {
        const [a, b] = gen();
        const k = pairKey(a.text, b.text);
        if (seen.has(k) || isTaken(a.text, b.text)) continue;
        seen.add(k);
        got++;
        cands.push({ a, b, k, gen: name });
      }
    }
    // 2) If chance finds nothing, sweep everything starting with the best elements.
    if (!cands.length) {
      const sorted = items.slice().sort((x, y) => score(y.text) - score(x.text));
      for (let i = 0; i < n && !cands.length; i++) {
        for (let j = 0; j <= i; j++) {
          if (!isTaken(sorted[i].text, sorted[j].text)) {
            cands.push({ a: sorted[i], b: sorted[j], k: pairKey(sorted[i].text, sorted[j].text), gen: null });
            break;
          }
        }
      }
      if (!cands.length) return null;
    }
    // 3) The model scores them all and one is chosen with Boltzmann exploration
    //    (Gumbel trick: argmax of z/T + noise is a sample from softmax(z/T)).
    const explore = Math.random() < EPSILON;
    let best = null;
    let bestKey = -Infinity;
    let sumP = 0;
    for (const c of cands) {
      evaluate(c);
      sumP += c.pNew;
      const key = explore ? Math.random() : c.z / TEMP - Math.log(-Math.log(Math.random() || 1e-12));
      if (key > bestKey) { bestKey = key; best = c; }
    }
    best.poolP = sumP / cands.length;
    best.nCands = cands.length;
    return best;
  }

  // ---------- Alerts ----------
  let audio = null;
  function chime() {
    if (!settings.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const t0 = audio.currentTime;
      [880, 1318.5].forEach((f, i) => {
        const o = audio.createOscillator();
        const g = audio.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + i * 0.12);
        g.gain.exponentialRampToValueAtTime(0.15, t0 + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.35);
        o.connect(g).connect(audio.destination);
        o.start(t0 + i * 0.12);
        o.stop(t0 + i * 0.12 + 0.4);
      });
    } catch (e) {}
  }
  const baseTitle = document.title;
  let unseenFirsts = 0;
  const updateTitle = () => {
    document.title = unseenFirsts ? `🏆 ${unseenFirsts} · ${baseTitle}` : baseTitle;
  };
  const onVisibility = () => { if (!document.hidden) { unseenFirsts = 0; updateTitle(); } };
  document.addEventListener('visibilitychange', onVisibility);

  // ---------- Panel ----------
  const panel = document.createElement('div');
  panel.id = 'autocraft-panel';
  panel.innerHTML = `
    <style>
      #autocraft-panel{--bg:rgba(255,255,255,.97);--fg:#111;--muted:#666;--faint:#999;--line:#e8e8e8;--chip:#f1f1f1;
        --head:#111;--headfg:#fff;--new:#e6f8ec;--first:#fff1c2;--green:#0a7d33;--gold:#b07800;--blue:#1d4ed8;
        --warn:#fff1f0;--warnfg:#b42318;
        position:fixed;top:64px;left:10px;z-index:99999;width:min(380px,calc(100vw - 20px));
        font:13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--fg);
        border:1px solid var(--line);border-radius:12px;box-shadow:0 10px 32px rgba(0,0,0,.2);overflow:hidden;user-select:none}
      #autocraft-panel.dark{--bg:rgba(24,24,27,.97);--fg:#f4f4f5;--muted:#a1a1aa;--faint:#71717a;--line:#333338;--chip:#2a2a30;
        --head:#000;--headfg:#fff;--new:#12341f;--first:#3d300a;--green:#4ade80;--gold:#fbbf24;--blue:#93c5fd;
        --warn:#3b1414;--warnfg:#fca5a5}
      #autocraft-panel *{box-sizing:border-box}
      #autocraft-panel header{display:flex;align-items:center;gap:6px;padding:8px 10px;background:var(--head);color:var(--headfg);font-weight:600;cursor:move;touch-action:none}
      #autocraft-panel header .t{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #autocraft-panel header .mini{font-weight:400;opacity:.8;font-size:12px}
      #autocraft-panel button{font:inherit;border:0;border-radius:6px;padding:3px 9px;cursor:pointer;background:var(--chip);color:var(--fg)}
      #autocraft-panel header button{background:#fff;color:#111}
      #autocraft-panel header button.on{background:#22c55e;color:#fff}
      #autocraft-panel select,#autocraft-panel input[type=search],#autocraft-panel input[type=text]{font:inherit;font-size:12px;color:var(--fg);background:var(--chip);border:1px solid var(--line);border-radius:6px;padding:2px 6px}
      #autocraft-panel.collapsed .body{display:none}
      #ac-stats{display:grid;grid-template-columns:repeat(6,1fr);gap:2px;padding:8px 4px 4px;text-align:center;font-size:10.5px;color:var(--muted)}
      #ac-stats b{display:block;font-size:15px;color:var(--fg);font-variant-numeric:tabular-nums}
      #ac-stats .hl b{color:var(--green)}
      #ac-stats .gold b{color:var(--gold)}
      #ac-spark{display:block;width:100%;height:30px;border-bottom:1px solid var(--line)}
      .ac-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line);font-size:12px;flex-wrap:wrap}
      .ac-row input[type=range]{flex:1;min-width:80px}
      .ac-row label{display:flex;align-items:center;gap:3px;white-space:nowrap;cursor:pointer}
      #ac-pace-label{min-width:34px;text-align:right;font-variant-numeric:tabular-nums}
      #ac-cap{color:var(--muted);font-size:11px}
      #ac-target{flex:1;min-width:120px}
      #ac-target-info{width:100%;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #ac-target-info:empty{display:none}
      #ac-brain{padding:5px 10px;border-bottom:1px solid var(--line);font-size:11px;color:var(--muted)}
      #ac-brain b{color:var(--blue);font-weight:600}
      #ac-strats{display:flex;gap:5px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--line);font-size:11px;color:var(--muted)}
      #ac-strats span{padding:1px 7px;border-radius:999px;background:var(--chip);position:relative;overflow:hidden}
      #ac-strats span i{position:absolute;left:0;bottom:0;height:2px;background:var(--green)}
      #ac-strats span.top{color:var(--fg);font-weight:600}
      #ac-log{height:200px;overflow-y:auto;margin:0;padding:4px 0;list-style:none;user-select:text}
      #ac-log li{padding:2px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--faint)}
      #ac-log li.new{background:var(--new);color:var(--fg)}
      #ac-log li.first{background:var(--first);color:var(--fg)}
      #ac-log li.new b,#ac-log li.first b{font-weight:700}
      #ac-log li small{color:var(--muted)}
      #ac-search{flex:1;min-width:80px}
      #ac-life{padding:4px 10px;font-size:11px;color:var(--muted);border-top:1px solid var(--line)}
      #ac-status{padding:5px 10px;font-size:11px;color:var(--muted);border-top:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      #ac-status.warn{background:var(--warn);color:var(--warnfg)}
    </style>
    <header id="ac-head">
      <span class="t">🤖 Auto-Craft ${VERSION} <span class="mini" id="ac-mini"></span></span>
      <button id="ac-toggle" title="Alt+P"></button>
      <button id="ac-min" title="Collapse (Alt+M)">–</button>
      <button id="ac-close" title="Close">✕</button>
    </header>
    <div class="body">
      <div id="ac-stats">
        <div class="hl"><b id="ac-new">0</b>new</div>
        <div class="gold"><b id="ac-firsts">0</b>🏆 first</div>
        <div><b id="ac-combos">0</b>combos</div>
        <div><b id="ac-hit">0%</b>hit rate</div>
        <div><b id="ac-rate">0</b>/min</div>
        <div><b id="ac-time">0:00</b>time</div>
      </div>
      <canvas id="ac-spark" title="New elements per minute (last 30 min). Gold = 🏆"></canvas>
      <div class="ac-row" title="Combinations per second. Go too fast and neal.fun blocks you for a while.">
        🐢<input id="ac-pace" type="range" min="${PACE_MIN}" max="${PACE_MAX}" step="0.5">🐇
        <span id="ac-pace-label"></span><span id="ac-cap"></span>
      </div>
      <div class="ac-row">
        <label title="What the model rewards when choosing">🎯<select id="ac-goal">
          <option value="new">✨ New</option><option value="first">🏆 First discoveries</option></select></label>
        <label title="Auto-stop">⏹<select id="ac-stop">
          <option value="">Never</option><option value="m15">15 min</option><option value="m30">30 min</option>
          <option value="m60">1 h</option><option value="m120">2 h</option>
          <option value="i50">+50 new</option><option value="i200">+200 new</option>
          <option value="f1">+1 🏆</option><option value="f10">+10 🏆</option></select></label>
        <label title="Sound on a 🏆 or when the search target is found"><input id="ac-sound" type="checkbox">🔔</label>
      </div>
      <div class="ac-row" title="Steers the search towards similar names and stops when found. Enter to set, empty to clear.">
        🔎<input id="ac-target" type="text" placeholder="Search for an element (e.g. Dragon) + Enter">
        <div id="ac-target-info"></div>
      </div>
      <div id="ac-brain"></div>
      <div id="ac-strats"></div>
      <div class="ac-row">
        <input id="ac-search" type="search" placeholder="Filter the log…">
        <label><input id="ac-onlyhits" type="checkbox">Hits only</label>
      </div>
      <ul id="ac-log"></ul>
      <div class="ac-row">
        <button id="ac-export" title="Download a .txt with all your first discoveries and their recipes">📥 Export 🏆</button>
        <button id="ac-reset" title="Forget what has been learned (model and strategies)">↺ Relearn</button>
      </div>
      <div id="ac-life"></div>
    </div>
    <div id="ac-status"></div>`;
  document.body.appendChild(panel);

  const $ = (id) => panel.querySelector('#' + id);
  const logEl = $('ac-log');
  const paceInput = $('ac-pace');
  const toggleBtn = $('ac-toggle');
  const searchInput = $('ac-search');
  const targetInput = $('ac-target');

  // Saved position and dragging by the header.
  function placePanel(x, y) {
    const r = panel.getBoundingClientRect();
    x = clamp(x, 0, Math.max(0, innerWidth - r.width));
    y = clamp(y, 0, Math.max(0, innerHeight - 40));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    settings.pos = [x, y];
  }
  if (Array.isArray(settings.pos)) placePanel(settings.pos[0], settings.pos[1]);
  $('ac-head').addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev) => placePanel(ev.clientX - dx, ev.clientY - dy);
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      saveSettings();
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });
  const onResize = () => { if (settings.pos) placePanel(settings.pos[0], settings.pos[1]); };
  addEventListener('resize', onResize);
  // Keep keys typed into the panel away from the game.
  panel.addEventListener('keydown', (e) => { if (e.target.matches('input,select')) e.stopPropagation(); });

  function setCollapsed(c) {
    settings.collapsed = c;
    panel.classList.toggle('collapsed', c);
    $('ac-min').textContent = c ? '▢' : '–';
    saveSettings();
  }
  setCollapsed(!!settings.collapsed);
  $('ac-min').onclick = () => setCollapsed(!settings.collapsed);

  function syncPaceInput() {
    paceInput.value = state.desired;
    $('ac-pace-label').textContent = state.pace + '/s';
    $('ac-cap').textContent = state.paceCap < PACE_MAX ? `(cap ${state.paceCap})` : '';
    $('ac-cap').title = state.paceCap < PACE_MAX
      ? 'Cap after a block: rises 0.5/s every 20 min without blocks' : '';
  }
  syncPaceInput();
  paceInput.oninput = () => {
    state.desired = clamp(+paceInput.value, PACE_MIN, PACE_MAX);
    settings.pace = state.desired;
    saveSettings();
    syncPaceInput();
    if (state.desired > state.paceCap) setStatus(`Capped at ${state.paceCap}/s after a recent block; it will recover on its own`);
  };

  $('ac-goal').value = state.goal;
  $('ac-goal').onchange = (e) => setGoal(e.target.value);
  function setGoal(g) {
    state.goal = g === 'first' ? 'first' : 'new';
    settings.goal = state.goal;
    $('ac-goal').value = state.goal;
    saveSettings();
    scheduleRefresh();
  }

  function setTarget(text) {
    let t = String(text || '').trim();
    const items = IC.getItems();
    const have = t && items.find((i) => i.text.toLowerCase() === t.toLowerCase());
    if (have) {
      // Already owned: no need to search, show how it was made instead.
      const byId = new Map(items.map((i) => [i.id, i]));
      const r = (have.recipes || [])[0];
      const a = r && byId.get(r[0]);
      const b = r && byId.get(r[1]);
      t = '';
      setStatus(`You already have ${have.emoji || ''} ${have.text}` + (a && b ? ` (${a.text} + ${b.text})` : ''));
    }
    state.target = t;
    settings.target = t;
    saveSettings();
    targetInput.value = t;
    targetTri = t ? trigrams(t) : null;
    state.closest = null;
    pool = null;
    if (!t) { if (!have) setStatus('Search cleared'); scheduleRefresh(); return; }
    for (const it of items) noteClosest(it);
    setStatus(`Searching for "${t}"…`);
    scheduleRefresh();
  }
  targetInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') setTarget(targetInput.value); });
  targetInput.addEventListener('change', () => setTarget(targetInput.value));

  $('ac-stop').onchange = (e) => {
    const v = e.target.value;
    if (!v) { state.stop = null; return; }
    const n = +v.slice(1);
    stopAfter(v[0] === 'm' ? { minutes: n } : v[0] === 'i' ? { items: n } : { firsts: n }, true);
  };
  function stopAfter(opts, fromUi) {
    if (!opts) { state.stop = null; $('ac-stop').value = ''; return; }
    state.stop = {
      until: opts.minutes ? Date.now() + opts.minutes * 60000 : 0,
      items: opts.items ? state.newItems + opts.items : 0,
      firsts: opts.firsts ? state.firsts + opts.firsts : 0,
    };
    if (!fromUi) $('ac-stop').value = '';
    setStatus('Auto-stop scheduled');
  }
  function checkStop() {
    const s = state.stop;
    if (!s || !state.running) return;
    const hit = (s.until && Date.now() >= s.until) || (s.items && state.newItems >= s.items) ||
      (s.firsts && state.firsts >= s.firsts);
    if (!hit) return;
    state.stop = null;
    $('ac-stop').value = '';
    pause();
    chime();
    setStatus('⏹ Auto-stop reached: press Resume to continue');
  }

  $('ac-sound').checked = !!settings.sound;
  $('ac-sound').onchange = (e) => { settings.sound = e.target.checked; saveSettings(); if (settings.sound) chime(); };
  $('ac-onlyhits').checked = !!settings.onlyHits;
  $('ac-onlyhits').onchange = (e) => { settings.onlyHits = e.target.checked; saveSettings(); renderLog(); };
  searchInput.oninput = () => renderLog();

  const showToggle = () => {
    toggleBtn.textContent = state.running ? '⏸ Pause' : '▶ Resume';
    toggleBtn.classList.toggle('on', !state.running);
  };
  showToggle();
  function pause() { state.running = false; showToggle(); setStatus('Paused'); }
  function resume() { state.running = true; showToggle(); setStatus('Resumed'); }
  toggleBtn.onclick = () => (state.running ? pause() : resume());
  $('ac-close').onclick = () => window.autoCraft && window.autoCraft.destroy();
  $('ac-export').onclick = () => exportFirsts();
  $('ac-reset').onclick = () => { resetLearning(); setStatus('Model and strategies reset'); };

  const onKey = (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.code === 'KeyP') { e.preventDefault(); state.running ? pause() : resume(); }
    else if (e.code === 'KeyM') { e.preventDefault(); setCollapsed(!settings.collapsed); }
  };
  addEventListener('keydown', onKey);

  function setStatus(text, warn) {
    const el = $('ac-status');
    el.textContent = text;
    el.className = warn ? 'warn' : '';
  }

  // Rate measured over the last 20 s, and a per-minute chart of the last 30.
  const stamps = [];
  const ratePerMin = () => {
    const cutoff = Date.now() - 20000;
    while (stamps.length && stamps[0] < cutoff) stamps.shift();
    return stamps.length * 3;
  };
  const buckets = new Map();   // minute -> [new, 🏆, combos]
  function bump(gaveNew, gaveFirst) {
    const m = Math.floor(Date.now() / 60000);
    const b = buckets.get(m) || [0, 0, 0];
    if (gaveNew) b[0]++;
    if (gaveFirst) b[1]++;
    b[2]++;
    buckets.set(m, b);
    for (const k of buckets.keys()) if (k < m - 30) buckets.delete(k);
  }
  function drawSpark() {
    const c = $('ac-spark');
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w) return;
    const dpr = devicePixelRatio || 1;
    if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const now = Math.floor(Date.now() / 60000);
    let max = 1;
    for (const b of buckets.values()) max = Math.max(max, b[0]);
    const bw = w / 30;
    const css = getComputedStyle(panel);
    for (let i = 0; i < 30; i++) {
      const b = buckets.get(now - 29 + i);
      if (!b) continue;
      const bh = Math.max(1, ((h - 4) * b[0]) / max);
      ctx.fillStyle = css.getPropertyValue('--green');
      ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
      if (b[1]) {
        const fh = Math.max(2, ((h - 4) * b[1]) / max);
        ctx.fillStyle = css.getPropertyValue('--gold');
        ctx.fillRect(i * bw + 1, h - fh, bw - 2, fh);
      }
    }
  }

  const isDark = () => (game && game.$data ? !!game.$data.isDarkMode
    : matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);

  // The panel repaints at most ~6 times a second.
  let refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => { refreshTimer = null; refreshStats(); }, 160);
  }
  function refreshStats() {
    if (state.destroyed) return;
    panel.classList.toggle('dark', isDark());
    const hit = state.combos ? Math.round((100 * state.newItems) / state.combos) + '%' : '0%';
    $('ac-new').textContent = state.newItems;
    $('ac-firsts').textContent = state.firsts;
    $('ac-combos').textContent = state.combos;
    $('ac-hit').textContent = hit;
    $('ac-rate').textContent = ratePerMin();
    $('ac-time').textContent = fmtTime(state.activeMs);
    $('ac-mini').textContent = settings.collapsed ? `✨${state.newItems} 🏆${state.firsts} · ${hit}` : '';

    // How well the model predicts: mean prediction vs. actual outcome, and how much
    // better the chosen pair is than the average candidate (estimate).
    const brain = $('ac-brain');
    brain.textContent = '';
    const head = document.createElement('b');
    head.textContent = `🧠 ${model.lessons} lessons`;
    brain.append(head);
    if (calib.length >= 10) {
      let p = 0, y = 0, base = 0;
      for (const c of calib) { p += c[0]; y += c[1]; base += c[2]; }
      const n = calib.length;
      brain.append(` · predicts ${pct(p / n)} · actual ${pct(y / n)} · picks ×${(p / Math.max(base, 1e-9)).toFixed(1)} better than random`);
      brain.title = `Last ${n} combinations. "×" compares the predicted probability of the chosen pair with the mean over all candidates.`;
    } else brain.append(' · warming up…');
    if (state.latency) brain.append(` · ${Math.round(state.latency)} ms`);

    const info = $('ac-target-info');
    info.textContent = state.target && state.closest
      ? `Closest to "${state.target}": ${state.closest.emoji || ''} ${state.closest.text} (${Math.round(100 * state.closest.sim)}%)`
      : '';

    const strats = $('ac-strats');
    strats.textContent = '';
    const totalUsed = Object.values(strategies).reduce((s, x) => s + x.used, 0) || 1;
    let best = null;
    for (const [id, s] of Object.entries(strategies)) {
      if (!s.used) continue;
      if (!best || winsOf(s) / s.tries > winsOf(strategies[best]) / strategies[best].tries) best = id;
    }
    for (const [id, s] of Object.entries(strategies)) {
      if (id === 'objetivo' && !state.target && !s.used) continue;
      const chip = document.createElement('span');
      chip.textContent = `${s.label} ${pct(winsOf(s) / s.tries)}`;
      chip.title = `Recent hit rate (${state.goal === 'first' ? '🏆' : 'new'}) of the pairs it proposed. ` +
        `The model picked ${s.used} this session (green bar).`;
      if (id === best) chip.className = 'top';
      const bar = document.createElement('i');
      bar.style.width = (100 * s.used) / totalUsed + '%';
      chip.append(bar);
      strats.append(chip);
    }

    $('ac-life').textContent = `Save: ${getPool().items.length} elements · ${rare.size} 🏆 · ` +
      `${nothingPairs.size} "Nothing" pairs remembered · All time: ${lifetime.newItems} new, ` +
      `${lifetime.firsts} 🏆 in ${lifetime.combos} combos`;
    drawSpark();
  }

  // Log: the latest entries are kept and rendered through the filter.
  // Built with textContent: names come from the server.
  const entries = [];
  const ICONS = { first: '🏆 ', new: '✨ ', repeat: '↺ ', nothing: '∅ ', target: '🎯 ' };
  const isHit = (k) => k === 'new' || k === 'first' || k === 'target';
  function makeLi(e) {
    const li = document.createElement('li');
    if (isHit(e.kind)) li.className = e.kind === 'new' ? 'new' : 'first';
    const b = document.createElement('b');
    b.textContent = e.main;
    const small = document.createElement('small');
    small.textContent = '  ←  ' + e.recipe + (e.p != null ? `  · ${pct(e.p)}` : '');
    li.append(ICONS[e.kind], b, small);
    li.title = new Date(e.t).toLocaleTimeString() + ' · ' + e.main + ' ← ' + e.recipe +
      (e.p != null ? ` · the model gave it ${pct(e.p)}` : '');
    return li;
  }
  const visible = (e) => {
    if (settings.onlyHits && !isHit(e.kind)) return false;
    const q = searchInput.value.trim().toLowerCase();
    return !q || (e.main + ' ' + e.recipe).toLowerCase().includes(q);
  };
  function renderLog() {
    logEl.textContent = '';
    const frag = document.createDocumentFragment();
    for (let i = entries.length - 1; i >= 0; i--) if (visible(entries[i])) frag.append(makeLi(entries[i]));
    logEl.append(frag);
  }
  function addLog(kind, main, recipe, p) {
    const e = { kind, main, recipe, p, t: Date.now() };
    entries.push(e);
    if (entries.length > LOG_MAX) entries.shift();
    if (!visible(e)) return;
    logEl.prepend(makeLi(e));
    while (logEl.children.length > LOG_MAX) logEl.lastChild.remove();
  }

  function exportFirsts() {
    const items = IC.getItems();
    const byId = new Map(items.map((i) => [i.id, i]));
    const lines = items
      .filter((i) => i.discovery || rare.has(i.text))
      .map((i) => {
        const r = (i.recipes || [])[0];
        const a = r && byId.get(r[0]);
        const b = r && byId.get(r[1]);
        return `${i.emoji || ''} ${i.text}` + (a && b ? `  =  ${a.text} + ${b.text}` : '');
      });
    if (!lines.length) {
      setStatus('No first discoveries to export yet');
      return 0;
    }
    const text = `Infinite Craft · first discoveries (${lines.length})\n` +
      `Exported on ${new Date().toLocaleString()}\n\n` + lines.join('\n') + '\n';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    a.download = `infinite-craft-first-discoveries-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return lines.length;
  }
  function resetLearning() {
    initStrategies(null);
    resetModel();
    persistStats();
    scheduleRefresh();
  }

  // ---------- Periodic tasks ----------
  let lastTick = Date.now();
  const stopTicker = every(1000, () => {
    const now = Date.now();
    if (state.running && hasLock && now >= blockedUntil) state.activeMs += now - lastTick;
    lastTick = now;
    saveNothing();
    recoverCap();
    checkStop();
    const left = blockedUntil - now;
    if (left > 0) {
      const m = Math.floor(left / 60000);
      const s = Math.ceil((left % 60000) / 1000);
      setStatus(`neal.fun is throttling the connection. Retrying in ${m ? m + ' min ' : ''}${s}s · pace ${state.pace}/s`, true);
    } else if (!hasLock && state.running && now - lockAsked > 1500) {
      setStatus('Another tab is already running Auto-Craft; this one is waiting its turn', true);
    }
    if (!document.hidden) refreshStats();
  });
  const stopSync = every(15000, () => { syncHistory(); persistStats(); });

  // ---------- Workers ----------
  async function worker() {
    while (!state.destroyed) {
      if (!canWork()) { await sleep(200); continue; }
      await takeSlot();
      if (!canWork()) continue;

      const pick = pickPair();
      if (!pick) {
        setStatus('Every combination has been tried for now.');
        await sleep(1500);
        continue;
      }
      const { a, b, k, gen } = pick;
      const recipe = `${a.emoji || ''} ${a.text} + ${b.emoji || ''} ${b.text}`;
      inFlight.add(k);
      setStatus(`Trying ${recipe} · ${gen ? STRATS[gen] : 'sweep'} · ${pct(pick.pNew)} among ${pick.nCands} candidates`);

      const t0 = Date.now();
      let res = null;
      try { res = await craft(a, b); } catch (e) { console.warn('[autocraft]', e); }
      const api = (await (pending.get(k) || Promise.resolve(null))) || { kind: res ? 'ok' : 'error' };
      pending.delete(k);
      inFlight.delete(k);
      if (state.destroyed) break;

      if (!res && api.kind === 'ratelimit') { onRateLimited(api.retryAfter); continue; }
      if (!res && (api.kind === 'error' || api.kind === 'ok')) {
        // Server or game failure: does not count as a try; growing wait.
        state.errors++;
        errorStreak++;
        inc(errorsByPair, k);
        if (errorsByPair.get(k) >= 3) record(a.text, b.text, false, false);
        cooldownUntil = Math.max(cooldownUntil, Date.now() + Math.min(3000 * 2 ** (errorStreak - 1), 60000));
        setStatus(`Server error (${errorStreak} in a row), waiting…`, true);
        continue;
      }
      const dt = Date.now() - t0;
      state.latency = state.latency ? 0.9 * state.latency + 0.1 * dt : dt;
      errorStreak = 0;
      if (++okSinceBlock >= 300) state.blocks = 0;   // after a while without blocks, forget earlier ones
      state.combos++;
      lifetime.combos++;
      stamps.push(Date.now());

      let gaveNew = false;
      let gaveFirst = false;
      if (!res) {
        addNothing(k);
        recordNothing(a.text, b.text);
        state.nothing++;
        lifetime.nothing++;
        addLog('nothing', 'Nothing', recipe, pick.pNew);
      } else {
        const item = res.item;
        gaveNew = res.isNew;
        gaveFirst = gaveNew && (api.first || !!item.discovery);
        record(a.text, b.text, gaveNew, gaveFirst);
        if (gaveNew) {
          state.newItems++;
          lifetime.newItems++;
          recent.push(item.text);
          if (recent.length > RECENT_MAX) recent.shift();
          order.set(item.text, nItems);
          depth.set(item.text, 1 + Math.max(depth.get(a.text) || 0, depth.get(b.text) || 0));
          noteClosest(item);
          pool = null;   // let the new element into the draw right away
        } else state.repeats++;
        if (gaveFirst) {
          state.firsts++;
          lifetime.firsts++;
          rare.add(item.text);
          chime();
          if (document.hidden) { unseenFirsts++; updateTitle(); }
        }
        const found = gaveNew && state.target && item.text.toLowerCase() === state.target.toLowerCase();
        const kind = found ? 'target' : gaveFirst ? 'first' : gaveNew ? 'new' : 'repeat';
        addLog(kind, `${item.emoji || ''} ${item.text}`, recipe, pick.pNew);
        if (found) {
          chime();
          setTarget('');
          pause();
          setStatus(`🎯 Found: ${item.emoji || ''} ${item.text}! (${recipe})`);
        }
      }
      learn(model.new, pick.x, gaveNew ? 1 : 0);
      learn(model.first, pick.x, gaveFirst ? 1 : 0);
      model.lessons++;
      calib.push([pick.pNew, gaveNew ? 1 : 0, pick.poolP]);
      if (calib.length > CALIB_MAX) calib.shift();
      if (gen) rewardStrategy(gen, gaveNew, gaveFirst);
      bump(gaveNew, gaveFirst);
      checkStop();
      scheduleRefresh();
    }
  }

  // ---------- Console API ----------
  window.autoCraft = {
    version: VERSION,
    state,
    strategies,
    model,
    pause,
    resume,
    setPace(n) { paceInput.value = n; paceInput.oninput(); },
    setGoal,
    setTarget,
    stopAfter: (opts) => stopAfter(opts, false),
    exportFirsts,
    resetLearning,
    stats() {
      const s = {
        session: { new: state.newItems, firsts: state.firsts, combos: state.combos, nothing: state.nothing,
          repeats: state.repeats, errors: state.errors, blocks: state.blocks, time: fmtTime(state.activeMs) },
        allTime: { ...lifetime },
        pace: { current: state.pace, desired: state.desired, cap: state.paceCap, latencyMs: Math.round(state.latency) },
        model: Object.fromEntries(FEATURES.map((f, i) =>
          [f, { new: +model.new.w[i].toFixed(2), first: +model.first.w[i].toFixed(2) }])),
        strategies: Object.fromEntries(Object.entries(strategies).map(([id, x]) =>
          [x.label, { newRate: +(x.wNew / x.tries).toFixed(3), firstRate: +(x.wFirst / x.tries).toFixed(3), picked: x.used }])),
        pairsTried: tried.size,
        nothingPairs: nothingPairs.size,
        nothingStorage: db ? 'IndexedDB' : 'localStorage',
        timer: timerWorker ? 'worker (keeps running in background)' : 'setTimeout',
        tab: hasLock ? 'active' : 'waiting for another tab',
      };
      console.table(s.session);
      console.table(s.model);
      return s;
    },
    resetPaceCap() {
      state.paceCap = PACE_MAX;
      lastCapChange = Date.now();
      try { localStorage.removeItem(KEYS.cap); } catch (e) {}
      syncPaceInput();
    },
    forgetNothing,
    destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      stopTicker();
      stopSync();
      clearTimeout(refreshTimer);
      saveNothing();
      persistStats();
      saveSettings();
      if (releaseLock) releaseLock();
      if (window.fetch === wrappedFetch) window.fetch = origFetch;
      if (timerWorker) timerWorker.terminate();
      timerWorker = null;
      for (const cb of timerCbs.values()) cb();
      timerCbs.clear();
      if (audio) audio.close().catch(() => {});
      removeEventListener('keydown', onKey);
      removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      unseenFirsts = 0;
      updateTitle();
      panel.remove();
      if (window.autoCraft && window.autoCraft.state === state) delete window.autoCraft;
    },
  };

  // ---------- Startup ----------
  setStatus('Loading memory…');
  refreshStats();
  for (let i = 0; i < WORKERS; i++) worker();
  await loadNothing();
  if (state.destroyed) return 'Auto-Craft closed before it started';
  const startItems = syncHistory();
  // The latest discoveries before startup seed the "recent" strategy.
  for (const it of startItems.slice(-30)) if (!STARTERS.has(it.text) && !it.hidden) recent.push(it.text);
  if (settings.target) setTarget(settings.target);
  ready = true;
  if (!settings.target) setStatus(state.running ? 'Starting…' : 'Paused: press Resume');
  refreshStats();
  const msg = `Auto-Craft ${VERSION} ` + (state.running ? 'running' : 'loaded (paused)') +
    (game ? '' : ' (compatibility mode)') + (timerWorker ? '' : ' · no Worker: will slow down in background') +
    (db ? '' : ' · no IndexedDB: memory in localStorage');
  console.log('[autocraft] ' + msg);
  return msg;
})();
