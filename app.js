/* ============================================================
   JewelBox — app logic
   Data lives on-device only: IndexedDB (jewels) + localStorage (settings, rate cache)
   ============================================================ */

"use strict";

/* ---------------- constants ---------------- */

const JEWEL_TYPES = [
  "Chain", "Necklace", "Kasu Malai", "Bangle", "Ring", "Earrings",
  "Kada", "Bracelet", "Pendant", "Anklet", "Waist Chain", "Nose Pin",
  "Mangalsutra", "Coin", "Bar", "Other"
];

const PURITIES = {
  gold: [
    { label: "24k · 999", stamp: "999", factor: 0.999 },
    { label: "22k · 916", stamp: "916", factor: 0.916 },
    { label: "18k · 750", stamp: "750", factor: 0.750 }
  ],
  silver: [
    { label: "Fine · 999", stamp: "999", factor: 0.999 },
    { label: "Sterling · 925", stamp: "925", factor: 0.925 }
  ]
};

const TROY_OZ_G = 31.1034768;
const RATE_CACHE_MS = 24 * 60 * 60 * 1000; // 24h

const DEFAULT_SETTINGS = {
  theme: "velvet",
  accent: "gold",
  provider: "goldapi",   // goldapi | metalsdev
  apiKey: "",
  premiumPct: 8,         // spot → Indian retail premium
  recoveryPct: 3,        // exchange/melt deduction a shop applies
  manualGold: null,      // ₹/g pure (999) — overrides live when set
  manualSilver: null
};

/* ---------------- tiny helpers ---------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const fmtINR = (n, dec = 0) =>
  n == null || isNaN(n) ? "—" :
  "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: dec, minimumFractionDigits: 0 });

const fmtG = n => n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 });

const fmtDate = iso => {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/* ---------------- settings ---------------- */

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("jb_settings") || "{}") };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(s) {
  localStorage.setItem("jb_settings", JSON.stringify(s));
}
let settings = loadSettings();

function applyTheme() {
  document.body.dataset.theme = settings.theme;
  document.body.dataset.accent = settings.accent;
  const meta = $('meta[name="theme-color"]');
  const bg = { velvet: "#1a1114", ivory: "#f2ece3", onyx: "#000000" }[settings.theme];
  if (meta) meta.setAttribute("content", bg);
}

/* ---------------- IndexedDB ---------------- */

let _db;
function db() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("jewelbox", 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("jewels")) {
        d.createObjectStore("jewels", { keyPath: "id" });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}
function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction("jewels", mode);
    const store = t.objectStore("jewels");
    const out = fn(store);
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => reject(t.error);
  }));
}
const putJewel = j => tx("readwrite", s => s.put(j));
const deleteJewel = id => tx("readwrite", s => s.delete(id));
function getAllJewels() {
  return db().then(d => new Promise((resolve, reject) => {
    const req = d.transaction("jewels").objectStore("jewels").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}

/* ---------------- rates ---------------- */

function getRateCache() {
  try { return JSON.parse(localStorage.getItem("jb_rates") || "null"); } catch { return null; }
}
function setRateCache(r) { localStorage.setItem("jb_rates", JSON.stringify(r)); }

async function fetchLiveRates() {
  const key = settings.apiKey.trim();
  if (!key) throw new Error("Add your API key in Settings first.");

  let gold, silver, source;

  if (settings.provider === "goldapi") {
    const opts = { headers: { "x-access-token": key } };
    const [gRes, sRes] = await Promise.all([
      fetch("https://www.goldapi.io/api/XAU/INR", opts),
      fetch("https://www.goldapi.io/api/XAG/INR", opts)
    ]);
    if (!gRes.ok || !sRes.ok) throw new Error("goldapi.io request failed (" + gRes.status + "). Check the key.");
    const g = await gRes.json(), s = await sRes.json();
    gold = g.price_gram_24k || (g.price / TROY_OZ_G);
    silver = s.price_gram_24k || (s.price / TROY_OZ_G);
    source = "goldapi.io";
  } else {
    const res = await fetch(`https://api.metals.dev/v1/latest?api_key=${encodeURIComponent(key)}&currency=INR&unit=g`);
    if (!res.ok) throw new Error("metals.dev request failed (" + res.status + "). Check the key.");
    const j = await res.json();
    if (!j.metals) throw new Error("metals.dev returned no data.");
    gold = j.metals.gold;
    silver = j.metals.silver;
    source = "metals.dev";
  }

  if (!gold || !silver) throw new Error("Rate response missing values.");
  const rates = { gold, silver, ts: Date.now(), source };
  setRateCache(rates);
  return rates;
}

/* Effective ₹/g for pure metal (999), after premium or manual override.
   Returns { perGram, source, ts, isManual } or null when nothing available. */
function effectiveRate(metal) {
  const manual = metal === "gold" ? settings.manualGold : settings.manualSilver;
  if (manual != null && manual !== "" && !isNaN(manual) && Number(manual) > 0) {
    return { perGram: Number(manual), source: "manual", ts: null, isManual: true };
  }
  const c = getRateCache();
  if (!c) return null;
  const spot = metal === "gold" ? c.gold : c.silver;
  return {
    perGram: spot * (1 + (Number(settings.premiumPct) || 0) / 100),
    source: c.source, ts: c.ts, isManual: false
  };
}

function jewelValue(j) {
  const r = effectiveRate(j.metal);
  if (!r) return null;
  return j.weight * j.purityFactor * r.perGram;
}

/* ---------------- photo compression ---------------- */

function compressPhoto(file, maxDim = 900, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const cv = document.createElement("canvas");
      cv.width = w; cv.height = h;
      cv.getContext("2d").drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Could not read that image.")); };
    img.src = url;
  });
}

/* ---------------- navigation ---------------- */

let currentTab = "home";

function nav(tab) {
  currentTab = tab;
  $$(".tab").forEach(b => b.setAttribute("aria-current", b.dataset.tab === tab ? "true" : "false"));
  closeSheet();
  const view = $("#view");
  view.style.animation = "none";
  void view.offsetWidth;
  view.style.animation = "";
  ({ home: renderHome, jewels: renderJewels, add: () => renderForm(), rates: renderRates, settings: renderSettings }[tab])();
}

$$(".tab").forEach(b => b.addEventListener("click", () => nav(b.dataset.tab)));

/* ---------------- sheet ---------------- */

function openSheet(html) {
  $("#sheet").innerHTML = html;
  $("#sheet").hidden = false;
  $("#sheetBackdrop").hidden = false;
}
function closeSheet() {
  $("#sheet").hidden = true;
  $("#sheetBackdrop").hidden = true;
  $("#sheet").innerHTML = "";
}
$("#sheetBackdrop").addEventListener("click", closeSheet);

/* ---------------- top bar rate strip ---------------- */

function renderTopbarRate() {
  const el = $("#topbarRate");
  const g = effectiveRate("gold"), s = effectiveRate("silver");
  if (!g && !s) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML =
    (g ? `<b>Au</b> ${fmtINR(g.perGram)}/g` : "") +
    (g && s ? " · " : "") +
    (s ? `<i>Ag</i> ${fmtINR(s.perGram)}/g` : "");
}

/* ---------------- HOME ---------------- */

async function renderHome() {
  const jewels = await getAllJewels();
  const view = $("#view");

  if (!jewels.length) {
    view.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="48" height="48"><path d="M7 4h10l3.5 5L12 20 3.5 9 7 4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
        <p>Your jewel box is empty.<br>Add your first piece to see its value here.</p>
        <br>
        <button class="btn btn-primary" style="width:auto" id="emptyAdd">Add a jewel</button>
      </div>`;
    $("#emptyAdd").addEventListener("click", () => nav("add"));
    return;
  }

  const agg = { gold: { g: 0, fine: 0, cost: 0 }, silver: { g: 0, fine: 0, cost: 0 } };
  let totalNow = 0, totalCost = 0, missingRate = false;

  for (const j of jewels) {
    const a = agg[j.metal];
    a.g += j.weight;
    a.fine += j.weight * j.purityFactor;
    a.cost += j.cost || 0;
    totalCost += j.cost || 0;
    const v = jewelValue(j);
    if (v == null) missingRate = true; else totalNow += v;
  }

  const goldRate = effectiveRate("gold"), silverRate = effectiveRate("silver");
  const goldNow = goldRate ? agg.gold.fine * goldRate.perGram : null;
  const silverNow = silverRate ? agg.silver.fine * silverRate.perGram : null;
  const gain = !missingRate ? totalNow - totalCost : null;
  const gainPct = gain != null && totalCost > 0 ? (gain / totalCost) * 100 : null;
  const recovery = !missingRate ? totalNow * (1 - (Number(settings.recoveryPct) || 0) / 100) : null;

  view.innerHTML = `
    <div class="card">
      <div class="hero-label">Portfolio value today</div>
      <div class="hero-value">${missingRate ? "—" : fmtINR(totalNow)}</div>
      ${gain != null ? `
        <div class="hero-gain ${gain >= 0 ? "gain-pos" : "gain-neg"}">
          ${gain >= 0 ? "▲" : "▼"} ${fmtINR(Math.abs(gain))} (${gainPct.toFixed(1)}%) vs invested
        </div>` : `
        <div class="hero-gain" style="color:var(--text-dim)">Set rates in the Rates tab to value the portfolio.</div>`}
      <div class="stat-grid" style="margin-top:14px">
        <div><div class="stat-label">Invested (incl. making &amp; GST)</div><div class="stat-num">${fmtINR(totalCost)}</div></div>
        <div><div class="stat-label">Est. recovery if sold (−${settings.recoveryPct}%)</div><div class="stat-num">${recovery != null ? fmtINR(recovery) : "—"}</div></div>
      </div>
    </div>

    <div class="metal-row">
      <div class="card metal-card m-gold">
        <div class="metal-name">Gold</div>
        <div class="metal-grams">${fmtG(agg.gold.g)}<small> g</small></div>
        <div class="metal-val">${goldNow != null ? fmtINR(goldNow) : "rate not set"}</div>
        <div class="metal-val" style="margin-top:2px">${fmtG(agg.gold.fine)} g fine</div>
      </div>
      <div class="card metal-card m-silver">
        <div class="metal-name">Silver</div>
        <div class="metal-grams">${fmtG(agg.silver.g)}<small> g</small></div>
        <div class="metal-val">${silverNow != null ? fmtINR(silverNow) : "rate not set"}</div>
        <div class="metal-val" style="margin-top:2px">${fmtG(agg.silver.fine)} g fine</div>
      </div>
    </div>

    <div class="card">
      <div class="stat-grid">
        <div><div class="stat-label">Pieces</div><div class="stat-num">${jewels.length}</div></div>
        <div><div class="stat-label">Owners</div><div class="stat-num">${new Set(jewels.map(j => j.owner).filter(Boolean)).size || "—"}</div></div>
      </div>
    </div>`;

  renderTopbarRate();
}

/* ---------------- JEWELS ---------------- */

let filterOwner = "all", filterMetal = "all";

async function renderJewels() {
  const jewels = (await getAllJewels()).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const view = $("#view");

  const owners = [...new Set(jewels.map(j => j.owner).filter(Boolean))];

  const shown = jewels.filter(j =>
    (filterMetal === "all" || j.metal === filterMetal) &&
    (filterOwner === "all" || j.owner === filterOwner));

  view.innerHTML = `
    <h2 class="section-title">Jewels</h2>
    <div class="filters">
      <button class="chip" data-fm="all" aria-pressed="${filterMetal === "all"}">All metals</button>
      <button class="chip" data-fm="gold" aria-pressed="${filterMetal === "gold"}">Gold</button>
      <button class="chip" data-fm="silver" aria-pressed="${filterMetal === "silver"}">Silver</button>
      ${owners.map(o => `<button class="chip" data-fo="${esc(o)}" aria-pressed="${filterOwner === o}">${esc(o)}</button>`).join("")}
      ${filterOwner !== "all" ? `<button class="chip" data-fo="all">✕ owner filter</button>` : ""}
    </div>
    ${shown.length ? `<div class="jewel-grid">${shown.map((j, i) => jewelCardHTML(j, i)).join("")}</div>`
      : `<div class="empty-state"><p>Nothing matches this filter.</p></div>`}`;

  $$("[data-fm]", view).forEach(b => b.addEventListener("click", () => { filterMetal = b.dataset.fm; renderJewels(); }));
  $$("[data-fo]", view).forEach(b => b.addEventListener("click", () => { filterOwner = b.dataset.fo; renderJewels(); }));
  $$(".jewel-card", view).forEach(c => c.addEventListener("click", () => openDetail(c.dataset.id)));
}

function jewelCardHTML(j, i) {
  const purity = PURITIES[j.metal].find(p => p.factor === j.purityFactor);
  return `
  <button class="jewel-card" data-id="${j.id}" style="animation-delay:${Math.min(i * 40, 320)}ms">
    ${j.photo
      ? `<img class="jewel-photo" src="${j.photo}" alt="${esc(j.name)}">`
      : `<div class="jewel-photo-empty"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M7 4h10l3.5 5L12 20 3.5 9 7 4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></div>`}
    <div class="jewel-meta">
      <div class="jewel-name">${esc(j.name)}</div>
      <div class="jewel-sub">
        <span class="jewel-grams">${fmtG(j.weight)} g</span>
        <span class="stamp ${j.metal === "silver" ? "s-silver" : ""}">${purity ? purity.stamp : ""}</span>
      </div>
      ${j.owner ? `<div class="jewel-owner">${esc(j.owner)}</div>` : ""}
    </div>
  </button>`;
}

/* ---------------- DETAIL ---------------- */

async function openDetail(id) {
  const jewels = await getAllJewels();
  const j = jewels.find(x => x.id === id);
  if (!j) return;

  const purity = PURITIES[j.metal].find(p => p.factor === j.purityFactor);
  const rate = effectiveRate(j.metal);
  const now = jewelValue(j);
  const boughtRate = j.cost && j.weight ? j.cost / j.weight : null;
  const gain = now != null && j.cost ? now - j.cost : null;
  const gainPct = gain != null && j.cost > 0 ? (gain / j.cost) * 100 : null;

  openSheet(`
    ${j.photo ? `<img class="detail-photo" src="${j.photo}" alt="${esc(j.name)}">` : ""}
    <div class="detail-title">${esc(j.name)}
      <span class="stamp ${j.metal === "silver" ? "s-silver" : ""}" style="vertical-align:middle;margin-left:6px">${purity ? purity.stamp : ""}</span>
    </div>
    <div class="detail-owner">${esc(j.owner || "No owner set")} · ${esc(j.type)} · ${j.metal === "gold" ? "Gold" : "Silver"}</div>

    <div class="kv"><span>Weight</span><b>${fmtG(j.weight)} g (${fmtG(j.weight * j.purityFactor)} g fine)</b></div>
    <div class="kv"><span>Bought on</span><b>${fmtDate(j.date)}</b></div>
    <div class="kv"><span>Purchase price</span><b>${fmtINR(j.cost)}</b></div>
    ${boughtRate ? `<div class="kv"><span>Effective bought rate</span><b>${fmtINR(boughtRate)}/g</b></div>` : ""}
    <div class="kv"><span>Rate today (pure)</span><b>${rate ? fmtINR(rate.perGram) + "/g" : "not set"}</b></div>
    <div class="kv"><span>Metal value today</span><b>${now != null ? fmtINR(now) : "—"}</b></div>
    ${gain != null ? `<div class="kv"><span>Gain vs invested</span><b class="${gain >= 0 ? "gain-pos" : "gain-neg"}">${gain >= 0 ? "+" : "−"}${fmtINR(Math.abs(gain))} (${gainPct.toFixed(1)}%)</b></div>` : ""}
    ${j.shop ? `<div class="kv"><span>Shop</span><b>${esc(j.shop)}</b></div>` : ""}
    ${j.notes ? `<div class="kv"><span>Notes</span><b style="font-weight:400">${esc(j.notes)}</b></div>` : ""}

    <div class="btn-row" style="margin-top:18px">
      <button class="btn btn-ghost" id="dEdit">Edit</button>
      <button class="btn btn-danger" id="dDelete">Delete</button>
    </div>`);

  $("#dEdit").addEventListener("click", () => { closeSheet(); renderForm(j); });
  $("#dDelete").addEventListener("click", async () => {
    if (!confirm(`Delete "${j.name}"? This cannot be undone.`)) return;
    await deleteJewel(j.id);
    closeSheet();
    toast("Jewel deleted");
    nav("jewels");
  });
}

/* ---------------- ADD / EDIT FORM ---------------- */

function renderForm(existing = null) {
  $$(".tab").forEach(b => b.setAttribute("aria-current", b.dataset.tab === "add" ? "true" : "false"));
  const view = $("#view");
  const isEdit = !!existing;
  const f = existing || {
    metal: "gold", type: "Chain",
    purityFactor: PURITIES.gold[1].factor, // 22k default — most Indian jewellery
    photo: null
  };

  view.innerHTML = `
    <h2 class="section-title">${isEdit ? "Edit jewel" : "Add a jewel"}</h2>

    <div class="field">
      <div class="photo-drop" id="photoDrop" role="button" tabindex="0" aria-label="Add photo">
        ${f.photo ? `<img src="${f.photo}" alt="Jewel photo">` : `
          <svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 8h3l2-3h6l2 3h3v11H4V8z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
          <span>Tap to photograph or choose an image</span>`}
      </div>
      <input type="file" id="photoInput" accept="image/*" capture="environment" hidden>
    </div>

    <div class="field">
      <label for="fName">Name</label>
      <input type="text" id="fName" placeholder="e.g. Kasu malai — wedding" value="${esc(f.name || "")}" maxlength="60">
    </div>

    <div class="field">
      <label>Metal</label>
      <div class="seg" id="segMetal">
        <button data-metal="gold" aria-pressed="${f.metal === "gold"}">Gold</button>
        <button data-metal="silver" aria-pressed="${f.metal === "silver"}">Silver</button>
      </div>
    </div>

    <div class="field">
      <label>Purity</label>
      <div class="seg" id="segPurity"></div>
      <div class="hint">Check the hallmark stamp on the piece.</div>
    </div>

    <div class="field">
      <label>Type</label>
      <div class="type-grid" id="typeGrid"></div>
    </div>

    <div class="field-row">
      <div class="field">
        <label for="fWeight">Net weight (g)</label>
        <input type="number" id="fWeight" inputmode="decimal" step="0.001" min="0" placeholder="0.000" value="${f.weight ?? ""}">
      </div>
      <div class="field">
        <label for="fOwner">Owner</label>
        <input type="text" id="fOwner" list="ownerList" placeholder="Whose is it?" value="${esc(f.owner || "")}" maxlength="30">
        <datalist id="ownerList"></datalist>
      </div>
    </div>

    <div class="field-row">
      <div class="field">
        <label for="fDate">Bought on</label>
        <input type="date" id="fDate" value="${f.date || ""}" max="${new Date().toISOString().slice(0, 10)}">
      </div>
      <div class="field">
        <label for="fCost">Purchase price (₹)</label>
        <input type="number" id="fCost" inputmode="numeric" step="1" min="0" placeholder="Total billed" value="${f.cost ?? ""}">
      </div>
    </div>

    <div class="field">
      <label for="fShop">Shop <span style="font-weight:400;color:var(--text-faint)">(optional)</span></label>
      <input type="text" id="fShop" placeholder="Where it was bought" value="${esc(f.shop || "")}" maxlength="60">
    </div>

    <div class="field">
      <label for="fNotes">Notes <span style="font-weight:400;color:var(--text-faint)">(optional)</span></label>
      <textarea id="fNotes" rows="2" placeholder="Stone weight, occasion, bill number…" maxlength="300">${esc(f.notes || "")}</textarea>
    </div>

    <button class="btn btn-primary" id="fSave">${isEdit ? "Save changes" : "Add to jewel box"}</button>
    ${isEdit ? `<button class="btn btn-ghost" id="fCancel" style="width:100%;margin-top:10px">Cancel</button>` : ""}
  `;

  /* owner suggestions */
  getAllJewels().then(js => {
    $("#ownerList").innerHTML = [...new Set(js.map(j => j.owner).filter(Boolean))]
      .map(o => `<option value="${esc(o)}">`).join("");
  });

  /* metal + purity segments */
  function drawPurity() {
    $("#segPurity").innerHTML = PURITIES[f.metal].map(p =>
      `<button data-factor="${p.factor}" aria-pressed="${p.factor === f.purityFactor}">${p.label}</button>`).join("");
    $$("#segPurity button").forEach(b => b.addEventListener("click", () => {
      f.purityFactor = Number(b.dataset.factor);
      $$("#segPurity button").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    }));
  }
  $$("#segMetal button").forEach(b => b.addEventListener("click", () => {
    f.metal = b.dataset.metal;
    f.purityFactor = PURITIES[f.metal][f.metal === "gold" ? 1 : 0].factor;
    $$("#segMetal button").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    drawPurity();
  }));
  drawPurity();

  /* type chips */
  function drawTypes() {
    $("#typeGrid").innerHTML = JEWEL_TYPES.map(t =>
      `<button class="chip" data-type="${t}" aria-pressed="${t === f.type}">${t}</button>`).join("");
    $$("#typeGrid .chip").forEach(b => b.addEventListener("click", () => {
      f.type = b.dataset.type;
      $$("#typeGrid .chip").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
    }));
  }
  drawTypes();

  /* photo */
  const drop = $("#photoDrop"), input = $("#photoInput");
  drop.addEventListener("click", () => input.click());
  drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") input.click(); });
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      f.photo = await compressPhoto(file);
      drop.innerHTML = `<img src="${f.photo}" alt="Jewel photo">`;
    } catch (err) { toast(err.message); }
  });

  /* save */
  $("#fSave").addEventListener("click", async () => {
    const name = $("#fName").value.trim();
    const weight = parseFloat($("#fWeight").value);
    if (!name) { toast("Give the jewel a name."); $("#fName").focus(); return; }
    if (!weight || weight <= 0) { toast("Enter the net weight in grams."); $("#fWeight").focus(); return; }

    const jewel = {
      id: existing ? existing.id : (crypto.randomUUID ? crypto.randomUUID() : "j" + Date.now() + Math.random().toString(36).slice(2)),
      name,
      metal: f.metal,
      type: f.type,
      purityFactor: f.purityFactor,
      weight,
      owner: $("#fOwner").value.trim(),
      date: $("#fDate").value || null,
      cost: parseFloat($("#fCost").value) || 0,
      shop: $("#fShop").value.trim(),
      notes: $("#fNotes").value.trim(),
      photo: f.photo || null,
      createdAt: existing ? existing.createdAt : Date.now()
    };
    await putJewel(jewel);
    toast(isEdit ? "Changes saved" : "Added to your jewel box");
    nav("jewels");
  });

  if (isEdit) $("#fCancel").addEventListener("click", () => nav("jewels"));
}

/* ---------------- RATES ---------------- */

async function renderRates() {
  const view = $("#view");
  const cache = getRateCache();
  const g = effectiveRate("gold"), s = effectiveRate("silver");

  const age = cache ? Math.round((Date.now() - cache.ts) / 36e5) : null;

  view.innerHTML = `
    <h2 class="section-title">Rates</h2>
    <p class="section-sub">₹ per gram of pure metal (999). Jewel values use these with the purity factor.</p>

    <div class="card">
      <div class="metal-name">Gold ${g && g.isManual ? '<span class="badge-override">MANUAL</span>' : ""}</div>
      <div class="rate-big" style="color:var(--gold-hi)">${g ? fmtINR(g.perGram) : "—"}<small> /g</small></div>
      ${g && !g.isManual ? `<div class="rate-meta">Spot ${fmtINR(cache.gold)} + ${settings.premiumPct}% India premium · ${cache.source}</div>` : ""}
    </div>

    <div class="card">
      <div class="metal-name">Silver ${s && s.isManual ? '<span class="badge-override">MANUAL</span>' : ""}</div>
      <div class="rate-big" style="color:var(--silver-hi)">${s ? fmtINR(s.perGram) : "—"}<small> /g</small></div>
      ${s && !s.isManual ? `<div class="rate-meta">Spot ${fmtINR(cache.silver)} + ${settings.premiumPct}% India premium · ${cache.source}</div>` : ""}
    </div>

    ${cache ? `<p class="section-sub">Live rates fetched ${age === 0 ? "under an hour" : age + " h"} ago. Auto-refreshes after 24 h.</p>` : ""}

    <button class="btn btn-primary" id="rFetch">Fetch live rates</button>

    <div class="card" style="margin-top:20px">
      <div class="field">
        <label for="rManualGold">Manual gold rate (₹/g pure) — overrides live</label>
        <input type="number" id="rManualGold" inputmode="numeric" placeholder="Leave empty to use live" value="${settings.manualGold ?? ""}">
      </div>
      <div class="field">
        <label for="rManualSilver">Manual silver rate (₹/g pure) — overrides live</label>
        <input type="number" id="rManualSilver" inputmode="numeric" placeholder="Leave empty to use live" value="${settings.manualSilver ?? ""}">
      </div>
      <div class="field" style="margin-bottom:0">
        <label for="rPremium">India premium on spot (%)</label>
        <input type="number" id="rPremium" inputmode="decimal" step="0.5" value="${settings.premiumPct}">
        <div class="hint">Import duty + local markup over international spot. Tune it so the gold rate matches your local shop's 24k board rate.</div>
      </div>
      <button class="btn btn-ghost" id="rSaveManual" style="width:100%;margin-top:14px">Save rate settings</button>
    </div>`;

  $("#rFetch").addEventListener("click", async e => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "Fetching…";
    try {
      await fetchLiveRates();
      toast("Live rates updated");
      renderRates(); renderTopbarRate();
    } catch (err) {
      toast(err.message);
      btn.disabled = false; btn.textContent = "Fetch live rates";
    }
  });

  $("#rSaveManual").addEventListener("click", () => {
    const mg = $("#rManualGold").value, ms = $("#rManualSilver").value;
    settings.manualGold = mg === "" ? null : parseFloat(mg);
    settings.manualSilver = ms === "" ? null : parseFloat(ms);
    settings.premiumPct = parseFloat($("#rPremium").value) || 0;
    saveSettings(settings);
    toast("Rate settings saved");
    renderRates(); renderTopbarRate();
  });

  renderTopbarRate();
}

/* ---------------- SETTINGS ---------------- */

function renderSettings() {
  const view = $("#view");

  view.innerHTML = `
    <h2 class="section-title">Settings</h2>

    <div class="card">
      <div class="field"><label>Theme</label>
        <div class="seg" id="segTheme">
          <button data-t="velvet" aria-pressed="${settings.theme === "velvet"}">Velvet</button>
          <button data-t="ivory" aria-pressed="${settings.theme === "ivory"}">Ivory</button>
          <button data-t="onyx" aria-pressed="${settings.theme === "onyx"}">Onyx</button>
        </div>
      </div>
      <div class="field" style="margin-bottom:8px"><label>Accent</label>
        <div class="swatch-row" id="swatches">
          ${[["gold", "#c9a03c"], ["rose", "#c96a6f"], ["emerald", "#3d9970"], ["sapphire", "#4a6fb5"], ["silver", "#97a3ad"]]
            .map(([n, c]) => `<button class="swatch" data-a="${n}" aria-pressed="${settings.accent === n}" aria-label="${n} accent" style="background:${c}"><span>${n}</span></button>`).join("")}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="field"><label>Rate provider</label>
        <div class="seg" id="segProvider">
          <button data-p="goldapi" aria-pressed="${settings.provider === "goldapi"}">goldapi.io</button>
          <button data-p="metalsdev" aria-pressed="${settings.provider === "metalsdev"}">metals.dev</button>
        </div>
      </div>
      <div class="field"><label for="sKey">API key</label>
        <input type="password" id="sKey" placeholder="Paste your free API key" value="${esc(settings.apiKey)}" autocomplete="off">
        <div class="hint">Stored only on this phone. Get a free key at goldapi.io or metals.dev — the free tier is plenty since rates cache for 24 h.</div>
      </div>
      <div class="field" style="margin-bottom:0"><label for="sRecovery">Recovery deduction if sold (%)</label>
        <input type="number" id="sRecovery" inputmode="decimal" step="0.5" value="${settings.recoveryPct}">
        <div class="hint">What a shop typically deducts when exchanging or melting.</div>
      </div>
      <button class="btn btn-ghost" id="sSave" style="width:100%;margin-top:14px">Save</button>
    </div>

    <div class="card">
      <div class="field" style="margin-bottom:10px"><label>Backup</label>
        <div class="hint" style="margin:0 0 12px">Everything lives on this phone only. Export a backup file before switching or resetting devices — photos are included.</div>
        <div class="btn-row">
          <button class="btn btn-ghost" id="sExport">Export backup</button>
          <button class="btn btn-ghost" id="sImport">Import backup</button>
        </div>
        <input type="file" id="importFile" accept="application/json,.json" hidden>
      </div>
    </div>`;

  $$("#segTheme button").forEach(b => b.addEventListener("click", () => {
    settings.theme = b.dataset.t; saveSettings(settings); applyTheme();
    $$("#segTheme button").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
  }));
  $$("#swatches .swatch").forEach(b => b.addEventListener("click", () => {
    settings.accent = b.dataset.a; saveSettings(settings); applyTheme();
    $$("#swatches .swatch").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
  }));
  $$("#segProvider button").forEach(b => b.addEventListener("click", () => {
    settings.provider = b.dataset.p;
    $$("#segProvider button").forEach(x => x.setAttribute("aria-pressed", x === b ? "true" : "false"));
  }));

  $("#sSave").addEventListener("click", () => {
    settings.apiKey = $("#sKey").value.trim();
    settings.recoveryPct = parseFloat($("#sRecovery").value) || 0;
    saveSettings(settings);
    toast("Settings saved");
  });

  $("#sExport").addEventListener("click", async () => {
    const jewels = await getAllJewels();
    const blob = new Blob([JSON.stringify({ app: "jewelbox", v: 1, exportedAt: new Date().toISOString(), settings: { ...settings, apiKey: "" }, jewels }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `jewelbox-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("Backup downloaded");
  });

  $("#sImport").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== "jewelbox" || !Array.isArray(data.jewels)) throw new Error("That file is not a JewelBox backup.");
      if (!confirm(`Import ${data.jewels.length} jewel(s)? Existing jewels with the same id will be replaced.`)) return;
      for (const j of data.jewels) await putJewel(j);
      toast(`Imported ${data.jewels.length} jewel(s)`);
      nav("jewels");
    } catch (err) { toast(err.message || "Import failed."); }
    e.target.value = "";
  });
}

/* ---------------- boot ---------------- */

applyTheme();
nav("home");
renderTopbarRate();

/* auto-refresh live rates if cache is stale and a key exists */
(async () => {
  const c = getRateCache();
  if (settings.apiKey && (!c || Date.now() - c.ts > RATE_CACHE_MS)) {
    try { await fetchLiveRates(); renderTopbarRate(); if (currentTab === "home") renderHome(); } catch { /* silent — manual fetch available */ }
  }
})();

/* PWA */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
