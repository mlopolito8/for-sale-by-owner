/*
 * listing.js — survey chat + live listing sheet (the buyer-facing PDF).
 *
 * Talks to /api/listing (Kaitlyn's Parley proxy). If that endpoint isn't deployed or
 * fails, it falls back to DEMO mode: scripted questions + a template-written
 * listing, so the page always works end to end.
 *
 * Output contract (live and demo produce the same shape):
 *   {
 *     headline: string,            // <= ~70 chars
 *     description: string,         // public remarks, <= 1000 chars
 *     highlights: string[],        // 4–6 short bullets
 *     details: { interior:{}, exterior:{}, systems:{}, costs:{} },  // label -> value
 *     contact: { name, phone, email, showings }
 *   }
 * Saved in localStorage under LISTING_KEY (photos are kept in memory only).
 */
(function () {
  const P = window.Property;
  const rec = P.load();
  if (!rec) { window.location.replace("intake.html"); return; }

  const LISTING_KEY = "fsbo.listing.v1";
  const MAX_DESC = 1000;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const usd = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const num = (n) => Number(n).toLocaleString("en-US");

  function readJSON(key) { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch (e) { return null; } }
  function writeJSON(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ } }

  const estimate = readJSON("fsbo.estimate.v1");
  const saved = readJSON(LISTING_KEY);
  // Only reuse a saved listing if it was made for this version of the property record.
  const S = {
    mode: null,                 // "live" | "demo"
    messages: [],               // chat history for the live API
    answers: {},                // demo mode answers by question key
    qIndex: -1,
    listing: saved && saved.recordAt === rec.updatedAt ? saved.listing : null,
    listPrice: saved && saved.recordAt === rec.updatedAt && saved.listPrice ? saved.listPrice : (estimate ? Math.round(estimate.estimate / 1000) * 1000 : null),
    showPrice: saved ? saved.showPrice !== false : true,
    photos: [],                 // data URLs
    busy: false,
  };
  function persist() { writeJSON(LISTING_KEY, { recordAt: rec.updatedAt, listing: S.listing, listPrice: S.listPrice, showPrice: S.showPrice }); }

  /* ------------------------------------------------------------------ *
   * Fair-housing guardrail (applied to live AND demo output)
   * Describe the property, not the buyer.
   * ------------------------------------------------------------------ */
  const FAIR_HOUSING = [
    [/\b(perfect|ideal|great|wonderful|excellent)\s+for\s+(a\s+)?(young\s+|growing\s+|small\s+|large\s+)?(famil(y|ies)|couples?|singles?|bachelors?|retirees|seniors|empty[- ]nesters|professionals|students|kids|children)\b/gi, "", "who the home is “perfect for”"],
    [/\bfamily[- ]friendly\b/gi, "", "“family-friendly”"],
    [/\b(family|adult|exclusive|christian|jewish|catholic|muslim)\s+(neighborhood|community|area)\b/gi, "neighborhood", "a description of who lives nearby"],
    [/\bsafe\s+(neighborhood|area|street|community)\b/gi, "quiet $1", "“safe neighborhood”"],
    [/\bmaster\s+(bedroom|suite|bath(room)?)\b/gi, "primary $1", "“master” (now “primary”)"],
    [/\bwalking distance to (church|synagogue|mosque|temple)\b/gi, "near local amenities", "places of worship"],
    [/\b(handicap|wheelchair)[- ]?(friendly|ready)\b/gi, "step-free entry", "disability-based wording"],
  ];
  function fairHousing(text) {
    const flagged = [];
    let out = String(text || "");
    for (const [re, rep, why] of FAIR_HOUSING) {
      if (re.test(out)) { flagged.push(why); out = out.replace(re, rep); }
      re.lastIndex = 0;
    }
    out = out.replace(/\s+([,.;])/g, "$1").replace(/,\s*([.;!?])/g, "$1").replace(/\b(and|with|or)\s*([.;])/gi, "$2").replace(/,\s*,/g, ",").replace(/ {2,}/g, " ").replace(/\.\s*\./g, ".").trim();
    return { text: out, flagged };
  }
  function cleanListing(L) {
    const flagged = new Set();
    const f = (s) => { const r = fairHousing(s); r.flagged.forEach((x) => flagged.add(x)); return r.text; };
    L.headline = f(L.headline);
    L.description = clip(f(L.description), MAX_DESC);
    L.highlights = (L.highlights || []).map(f).filter(Boolean).slice(0, 6);
    return [...flagged];
  }
  function clip(text, max) {
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(".\n"));
    return (end > max * 0.6 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…").trim();
  }

  /* ------------------------------------------------------------------ *
   * Demo-mode survey: scripted questions, skipping anything we know.
   * ------------------------------------------------------------------ */
  const typeLabel = P.labelFor("propertyType", rec.propertyType);
  const QUESTIONS = [
    { key: "standout", ask: () => `What's the first thing a buyer would notice walking in? Think light, layout, views, or a favorite room.`, chips: ["Open floor plan", "Lots of natural light", "Big backyard"] },
    { key: "updates", ask: () => `Any renovations or upgrades in the last 10 years? Include the year if you know it (e.g. "new roof 2021, bathroom remodel 2023").`, chips: ["None major"] },
    { key: "kitchen", ask: () => rec.kitchenUpdatedYear ? `You said the kitchen was updated in ${rec.kitchenUpdatedYear}. What's in it? Counters, appliances, island, pantry?` : `Tell me about the kitchen: counters, appliances, island, pantry?`, chips: ["Granite counters", "Stainless appliances", "Gas range"] },
    { key: "outdoor", ask: () => `What's the outdoor space like? Yard, deck, garden, views, privacy?`, chips: ["Fenced yard", "Deck", "No yard"] },
    { key: "systems", skip: () => rec.flooring && rec.hvacType && rec.parking, ask: () => `A few quick facts I'm missing: ${[!rec.flooring && "flooring", !rec.hvacType && "heating/cooling", !rec.parking && "parking"].filter(Boolean).join(", ")}?` },
    { key: "location", ask: () => `What's nearby that buyers ask about? Parks, transit, shops, commute times. (Describe places, not the people who live there.)`, chips: ["Near a park", "Close to transit", "Walk to shops"] },
    { key: "contact", ask: () => `Last one: how should buyers reach you? Name, phone and/or email, plus any showing instructions (e.g. "by appointment, 24h notice").` },
  ];
  const activeQuestions = () => QUESTIONS.filter((q) => !(q.skip && q.skip()));

  function sentence(s) {
    s = String(s || "").trim().replace(/^(i|we)\s+(really\s+)?(love|like)\s+(that\s+)?(the\s+)?/i, "the ")
      .replace(/^(my|our)\s+favorite\s+(thing|part|feature)\s+is\s+/i, "")
      .replace(/^(none( major)?|no|n\/?a|nope|skip)\.?$/i, "");
    if (!s) return "";
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return /[.!?]$/.test(s) ? s : s + ".";
  }
  function parseContact(t) {
    t = String(t || "");
    const email = (t.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [""])[0];
    const phone = (t.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/) || [""])[0];
    let rest = t.replace(email, "").replace(phone, "");
    const showingsMatch = rest.match(/(by appointment|showings?|open house|call|text|notice)[^.]*\.?/i);
    const showings = showingsMatch ? sentence(showingsMatch[0]) : "By appointment.";
    if (showingsMatch) rest = rest.replace(showingsMatch[0], "");
    const name = rest.replace(/[,;:|]/g, " ").replace(/\b(name|phone|email|is|my|i'm|im|and|or)\b/gi, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ");
    return { name: name || "The owner", phone, email, showings };
  }

  function amenityLabels() { return (rec.amenities || []).map((a) => P.labelFor("amenities", a)); }
  function listJoin(a) { return a.length < 2 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]; }

  function demoListing(a) {
    const place = rec.neighborhood || (rec.county ? rec.county : `ZIP ${rec.zip}`);
    const recentKitchen = rec.kitchenUpdatedYear && rec.kitchenUpdatedYear >= new Date().getFullYear() - 8;
    const adj = recentKitchen || (a.updates && !/^none/i.test(a.updates)) ? "Updated" : rec.yearBuilt < 1950 ? "Classic" : "Well-Kept";
    const typeWord = { "single-family": "Home", condo: "Condo", townhome: "Townhome", "multi-family": "Multi-Family" }[rec.propertyType] || "Home";
    const headline = `${adj} ${rec.bedrooms}-Bedroom ${typeWord} in ${place}`;

    const parts = [];
    parts.push(`This ${rec.bedrooms}-bedroom, ${rec.bathrooms}-bath ${typeLabel.toLowerCase()} offers ${num(rec.sqft)} square feet of living space${rec.stories ? ` across ${rec.stories} ${rec.stories > 1 ? "stories" : "story"}` : ""}. Built in ${rec.yearBuilt}${rec.lotSizeAcres ? `, it sits on a ${rec.lotSizeAcres}-acre lot` : ""}.`);
    if (a.standout) parts.push(sentence(a.standout));
    if (a.updates && sentence(a.updates)) parts.push("Recent updates: " + sentence(a.updates).replace(/^./, (c) => c.toLowerCase()));
    if (a.kitchen && sentence(a.kitchen)) parts.push(`The kitchen${rec.kitchenUpdatedYear ? `, updated in ${rec.kitchenUpdatedYear},` : ""} features ${sentence(a.kitchen).replace(/^./, (c) => c.toLowerCase())}`);
    const am = amenityLabels();
    if (am.length) parts.push(`Additional features include ${listJoin(am.map((x) => (/[A-Z]{2}/.test(x) ? x : x.toLowerCase()).replace(" / ", " and ")))}.`);
    if (a.outdoor && sentence(a.outdoor)) parts.push("Outside: " + sentence(a.outdoor).replace(/^./, (c) => c.toLowerCase()));
    if (a.location && sentence(a.location)) parts.push("Location: " + sentence(a.location).replace(/^./, (c) => c.toLowerCase()));
    const description = parts.join(" ");

    const highlights = [];
    if (a.updates && sentence(a.updates)) highlights.push(sentence(a.updates).replace(/\.$/, ""));
    if (recentKitchen) highlights.push(`Kitchen updated ${rec.kitchenUpdatedYear}`);
    if (rec.basement === "finished") highlights.push("Finished basement");
    if (rec.parking) highlights.push(rec.parking.charAt(0).toUpperCase() + rec.parking.slice(1));
    am.forEach((x) => highlights.push(x));
    if (a.outdoor && sentence(a.outdoor)) highlights.push(sentence(a.outdoor).replace(/\.$/, ""));

    return {
      headline, description, highlights: [...new Set(highlights)].slice(0, 6),
      details: a.systems && sentence(a.systems) ? { interior: { Other: sentence(a.systems).replace(/\.$/, "") } } : {},
      contact: parseContact(a.contact),
    };
  }

  /* MLS-style detail tables, grouped like a brokerage listing page.
     Rebuilt from the property record at render time (so price/status stay current);
     extra facts from the chatbot (listing.details) are merged in on top. */
  const GROUPS = [
    ["features", "Features"], ["community", "Community information"], ["amenities", "Amenities"],
    ["interior", "Interior"], ["exterior", "Exterior"], ["schools", "School information"], ["additional", "Additional information"],
  ];
  const GROUP_ALIASES = { systems: "interior", costs: "additional", location: "community", school: "schools" };
  const yesNo = (b) => (b ? "Yes" : "No");
  const has = (a) => (rec.amenities || []).includes(a);
  function bathSplit(b) { const full = Math.floor(b), half = b - full >= 0.5 ? 1 : 0; return { full, half }; }
  function bathText(b) { const { full, half } = bathSplit(b); return half ? `${full}½` : String(full); }

  function buildDetails(extra = {}) {
    const d = {}; GROUPS.forEach(([g]) => (d[g] = {}));
    const put = (g, k, v) => { if (v !== undefined && v !== null && v !== false && v !== "" && !(Array.isArray(v) && !v.length)) d[g][k] = Array.isArray(v) ? v.join(", ") : String(v); };
    const { full, half } = bathSplit(rec.bathrooms);
    put("features", "Price", S.showPrice && S.listPrice ? usd(S.listPrice) : "Contact owner");
    put("features", "Bedrooms", rec.bedrooms);
    put("features", "Bathrooms", rec.bathrooms);
    put("features", "Full baths", full);
    put("features", "Half baths", half);
    put("features", "Square footage", `${num(rec.sqft)}`);
    put("features", "Lot size", rec.lotSizeAcres && `${rec.lotSizeAcres} acres`);
    put("features", "Year built", rec.yearBuilt);
    put("features", "Type", "Residential");
    put("features", "Sub-type", typeLabel);
    put("features", "Status", "Active");
    put("community", "Address", rec.address);
    put("community", "Neighborhood", rec.neighborhood);
    put("community", "County", rec.county);
    put("community", "Zip code", rec.zip);
    put("amenities", "Garage / parking", rec.parking);
    put("amenities", "Has pool", yesNo(has("pool")));
    put("amenities", "Deck / patio", has("deck-patio") && "Yes");
    put("amenities", "Fenced yard", has("fenced-yard") && "Yes");
    put("amenities", "EV charger", has("ev-charger") && "Yes");
    put("amenities", "Solar panels", has("solar") && "Yes");
    put("interior", "Flooring", rec.flooring);
    put("interior", "Heating / cooling", rec.hvacType);
    put("interior", "Cooling", has("central-ac") && "Central air");
    put("interior", "Has basement", rec.basement && (rec.basement === "none" ? "No" : `Yes (${P.labelFor("basement", rec.basement).toLowerCase()})`));
    put("interior", "Fireplace", yesNo(has("fireplace")));
    put("interior", "Laundry", has("laundry") && "In unit");
    put("interior", "Kitchen updated", rec.kitchenUpdatedYear);
    put("interior", "Stories", rec.stories);
    put("exterior", "Exterior", rec.exteriorSiding);
    put("exterior", "Roof age", rec.roofAgeYears !== undefined && `${rec.roofAgeYears} years`);
    put("schools", "District", rec.schoolDistrict || "Ask owner");
    put("additional", "Date listed", new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }));
    put("additional", "Annual property tax", rec.annualPropertyTax && usd(rec.annualPropertyTax));
    put("additional", "HOA dues", rec.hoaMonthly !== undefined && `${usd(rec.hoaMonthly)} / month`);
    put("additional", "Typical utilities", rec.utilitiesMonthly && `${usd(rec.utilitiesMonthly)} / month`);
    put("additional", "Offered by", "Owner (no agent)");
    // Merge chatbot-provided facts (never overwrite record facts).
    for (const [g0, rows] of Object.entries(extra || {})) {
      const g = d[g0] ? g0 : GROUP_ALIASES[g0];
      if (!g || !rows || typeof rows !== "object") continue;
      for (const [k, v] of Object.entries(rows)) if (!(k in d[g])) put(g, k, v);
    }
    return d;
  }

  /* ------------------------------------------------------------------ *
   * Chat UI
   * ------------------------------------------------------------------ */
  const log = $("chat-log"), input = $("chat-input"), quick = $("quick");
  function say(role, text) {
    const m = document.createElement("div");
    m.className = "msg " + role;
    m.textContent = text;
    log.appendChild(m);
    log.scrollTop = log.scrollHeight;
    return m;
  }
  function setChips(chips = [], withSkip = true) {
    quick.innerHTML = "";
    const all = [...chips, ...(withSkip ? ["Skip"] : [])];
    all.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = c;
      b.onclick = () => handleAnswer(c === "Skip" ? "" : c, c);
      quick.appendChild(b);
    });
  }
  function setProgress(frac) { $("progress").style.width = Math.round(Math.min(1, frac) * 100) + "%"; }
  function setMode(m) {
    S.mode = m;
    $("mode-pill").textContent = m === "live" ? "Live · Parley" : "Demo mode";
    $("mode-pill").title = m === "live" ? "Answers go to the Parley model via /api/listing" : "The AI endpoint isn't connected, so questions and the draft come from a template.";
  }
  function setBusy(b) { S.busy = b; $("send").disabled = b; input.disabled = b; }

  const greeting = () => `Hi! I've got your basics: ${rec.bedrooms} bd · ${rec.bathrooms} ba · ${num(rec.sqft)} sq ft ${typeLabel.toLowerCase()} in ${rec.zip}, built ${rec.yearBuilt}. I'll ask a few quick questions about what makes it stand out, then draft your listing. You can skip any question.`;

  async function start() {
    log.innerHTML = ""; S.messages = []; S.answers = {}; S.qIndex = -1; S.awaitingContact = false; S.pendingListing = null; setProgress(0);
    say("bot", greeting());
    if (await tryLive()) return;
    setMode("demo");
    nextDemoQuestion();
  }

  function nextDemoQuestion() {
    const qs = activeQuestions();
    S.qIndex++;
    setProgress(S.qIndex / qs.length);
    if (S.qIndex >= qs.length) return finish(demoListing(S.answers));
    const q = qs[S.qIndex];
    say("bot", q.ask());
    setChips(q.chips || []);
    input.focus();
  }

  async function handleAnswer(text, shown) {
    if (S.busy) return;
    text = text.trim();
    say("user", shown || text || "(skipped)");
    input.value = "";
    if (S.mode === "live" && S.awaitingContact) {
      S.awaitingContact = false;
      const L = S.pendingListing; S.pendingListing = null;
      L.contact = parseContact(text);
      finish(L);
    } else if (S.mode === "live") {
      S.messages.push({ role: "user", content: text || "(skip this one)" });
      await liveTurn();
    } else {
      const q = activeQuestions()[S.qIndex];
      if (q) S.answers[q.key] = text;
      nextDemoQuestion();
    }
  }

  /* ---------------- Live mode (Parley via Kaitlyn's /api/listing) ----------------
   * Contract (api/listing.js):  POST { property, messages }  ->  { reply }
   * The first message must be from the user. The interview ends with
   *   <final>{"fields": {...MLS fields...}, "description": "..."}</final>
   * The API doesn't ask for contact info, so this page asks that one question itself. */
  const LIVE_START = "Please begin the interview.";
  const LIVE_MAX_Q = 8;
  async function callApi() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45000);
    try {
      const r = await fetch("/api/listing", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ property: rec, messages: S.messages }), signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.json();
      if (!data || typeof data.reply !== "string" || !data.reply.trim()) throw new Error("empty reply");
      return data.reply;
    } finally { clearTimeout(t); }
  }
  async function tryLive() {
    setBusy(true);
    const typing = say("bot typing", "…");
    S.messages = [{ role: "user", content: LIVE_START }];
    try {
      const reply = await callApi();
      typing.remove();
      setMode("live");
      handleLive(reply);
      return true;
    } catch (e) {
      typing.remove();
      S.messages = [];
      return false;
    } finally { setBusy(false); }
  }
  async function liveTurn() {
    setBusy(true);
    const typing = say("bot typing", "…");
    try {
      const reply = await callApi();
      typing.remove();
      handleLive(reply);
    } catch (e) {
      typing.remove();
      say("bot", "I lost the connection to the AI service, so I'll finish in demo mode with the questions I have left.");
      setMode("demo");
      S.answers.standout = S.messages.filter((m) => m.role === "user" && m.content !== LIVE_START).map((m) => m.content).join(". ");
      S.qIndex = 0;  // standout covered by the live answers
      nextDemoQuestion();
    } finally { setBusy(false); }
  }

  /* Map the model's flat MLS "fields" into the sheet's table groups. */
  const FIELD_GROUP = [
    [/garage|parking|pool|deck|patio|porch|fence|yard|amenit|solar|ev\b|charger|waterfront/i, "amenities"],
    [/roof|siding|exterior|foundation|construction|landscap|lot|driveway|window/i, "exterior"],
    [/school|district/i, "schools"],
    [/tax|hoa|fee|util|zoning|history|days|listed|dom|assess/i, "additional"],
    [/subdivision|neighbo|county|city|town|state|zip|address/i, "community"],
    [/kitchen|bath|floor|heat|cool|hvac|furnace|water heater|appliance|fireplace|basement|laundry|paint|interior|room|light|updat|renovat|condition/i, "interior"],
  ];
  const SKIP_FIELDS = /^(zip|bedrooms|bathrooms|beds|baths|sqft|squarefeet|square_?footage|yearbuilt|year_?built|propertytype|price|listprice|status|address)$/i;
  function humanize(k) { return String(k).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()); }
  function fieldsToDetails(fields) {
    const d = {};
    const add = (k, v) => {
      if (v === null || v === undefined || v === "" || SKIP_FIELDS.test(String(k).replace(/\s/g, ""))) return;
      if (typeof v === "object" && !Array.isArray(v)) { Object.entries(v).forEach(([k2, v2]) => add(k2, v2)); return; }
      const g = (FIELD_GROUP.find(([re]) => re.test(k)) || [null, "interior"])[1];
      (d[g] = d[g] || {})[humanize(k)] = Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v);
    };
    Object.entries(fields || {}).forEach(([k, v]) => add(k, v));
    return d;
  }

  function handleLive(reply) {
    S.messages.push({ role: "assistant", content: reply });
    const m = reply.match(/<final>([\s\S]*?)<\/final>/);
    if (!m) {
      say("bot", reply.trim());
      const asked = S.messages.filter((x) => x.role === "assistant").length;
      setProgress(Math.min(0.9, asked / (LIVE_MAX_Q + 1)));
      setChips([]);
      input.focus();
      return;
    }
    let obj = null;
    try { obj = JSON.parse(m[1]); } catch (e) { /* fall through */ }
    if (!obj || !obj.description) {
      say("bot", "I couldn't read the final listing. Send any message and I'll try again.");
      return;
    }
    const base = demoListing({});          // headline + record-based defaults
    S.pendingListing = {
      headline: obj.headline || base.headline,
      description: obj.description,
      highlights: [],
      details: fieldsToDetails(obj.fields),
      contact: null,
    };
    // One local question so the sheet has seller contact info.
    S.awaitingContact = true;
    setProgress(0.95);
    say("bot", "Great, I have what I need for the description. Last one: how should buyers reach you? Name, phone and/or email, plus any showing instructions (e.g. \"by appointment, 24h notice\").");
    setChips([]);
    input.focus();
  }

  function finish(L) {
    const flagged = cleanListing(L);
    S.listing = L;
    persist();
    setProgress(1);
    quick.innerHTML = "";
    say("bot", `Done! Your listing sheet is ready on the right (${L.description.length} of ${MAX_DESC} characters in the description). Click the headline or description to edit, add photos, then hit “Save as PDF”.`);
    if (flagged.length) say("bot", `Heads-up: I reworded a few phrases to stay within fair-housing rules (${flagged.join("; ")}). Listings should describe the property, not who should buy it.`);
    const again = document.createElement("button");
    again.type = "button"; again.textContent = "Start over"; again.onclick = start;
    quick.appendChild(again);
    render();
  }

  $("chat-form").addEventListener("submit", (e) => { e.preventDefault(); if (input.value.trim()) handleAnswer(input.value); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chat-form").requestSubmit(); } });
  $("restart").addEventListener("click", start);

  /* ------------------------------------------------------------------ *
   * Listing sheet
   * ------------------------------------------------------------------ */
  function render() {
    const L = S.listing;
    const addr = rec.address || `${typeLabel} in ${rec.zip}`;
    const city = [rec.neighborhood, rec.county && rec.county.replace(/\s*county$/i, "") + " County", rec.zip].filter(Boolean).join(", ");
    const priceText = S.showPrice && S.listPrice ? usd(S.listPrice) : "Contact for price";
    const photos = S.photos;
    const details = buildDetails(L && L.details);
    const c = (L && L.contact) || {};
    const rows = (g) => Object.entries(details[g] || {});
    const table = (g, title) => rows(g).length
      ? `<div class="sh-group"><h3>${esc(title)}</h3><table>${rows(g).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table></div>` : "";
    const ph = (i, cls = "") => photos[i] ? `<img class="${cls}" src="${photos[i]}" alt="">` : `<div class="ph ${cls}">${i === 0 ? "Add a cover photo" : ""}</div>`;
    const stats = [[rec.bedrooms, "Beds"], [bathText(rec.bathrooms), "Baths"], [num(rec.sqft), "Square feet"]];

    $("sheet").innerHTML = `
      <div class="page">
        <div class="sh-strip"><span>For sale by owner</span><span class="status">Active</span></div>
        <div class="sh-gallery-top">
          <div class="main">${ph(0)}${photos.length > 1 ? `<span class="count">1 of ${photos.length} photos</span>` : ""}</div>
          <div class="side">${ph(1)}${ph(2)}</div>
        </div>
        <div class="sh-title">
          <div>
            <h1>${esc(addr)}</h1>
            <div class="city">${esc(city)}</div>
          </div>
          <div class="price">${esc(priceText)}</div>
        </div>
        <div class="sh-stats">${stats.map(([v, k]) => `<div><b>${esc(v)}</b><span>${k}</span></div>`).join("")}
          <div class="tabs"><span>Overview</span><span>Facts &amp; features</span><span>Request showing</span></div>
        </div>
        <div class="sh-about">
          <h2>About ${esc(addr)}</h2>
          ${L ? `<p class="sh-headline" contenteditable="plaintext-only" data-edit="headline">${esc(L.headline)}</p>
                 <p class="sh-desc" contenteditable="plaintext-only" data-edit="description">${esc(L.description)}</p>`
              : `<p class="sh-headline placeholder">Your headline will appear here</p>
                 <p class="sh-desc placeholder">Answer the questions on the left and your description will be written here, ready to edit.</p>`}
        </div>
        <div class="sh-features">${table("features", `Features of ${addr}`)}</div>
        <div class="sh-foot"><span>${esc(addr)} · ${esc(priceText)}</span><span>Page 1 of 2</span></div>
      </div>
      <div class="page">
        <div class="sh-strip light"><span>${esc(addr)}</span><span>Facts &amp; features</span></div>
        <div class="sh-details">
          <div>${table("community", "Community information")}${table("amenities", "Amenities")}${table("schools", "School information")}</div>
          <div>${table("interior", "Interior")}${table("exterior", "Exterior")}${table("additional", "Additional information")}</div>
        </div>
        ${photos.length > 3 ? `<div class="sh-gallery">${photos.slice(3, 7).map((p) => `<img src="${p}" alt="">`).join("")}</div>` : ""}
        <div class="sh-contact">
          <div class="who">
            <div class="avatar">${esc((c.name || "O").trim().charAt(0).toUpperCase())}</div>
            <div>
              <div class="k">Listed by owner</div>
              <div class="name">${esc(c.name || "The owner")}</div>
              ${c.phone ? `<p>${esc(c.phone)}</p>` : ""}${c.email ? `<p>${esc(c.email)}</p>` : ""}
              ${!c.phone && !c.email ? `<p class="placeholder">Phone and email fill in after the Q&amp;A</p>` : ""}
            </div>
          </div>
          <div>
            <div class="k">Request a showing</div>
            <p>${esc(c.showings || "By appointment.")}</p>
            <p class="muted">Contact the owner directly to schedule. Please include your name, phone, and preferred times.</p>
          </div>
        </div>
        <div class="sh-fine">Offered for sale by the owner; no real estate agent is involved. Information is provided by the owner and believed accurate but not guaranteed. Buyers should independently verify square footage, lot size, taxes, HOA terms, and school assignments. Equal housing opportunity.</div>
      </div>`;

    $("sheet").querySelectorAll("[data-edit]").forEach((el) => {
      el.addEventListener("input", () => { S.listing[el.dataset.edit] = el.innerText.trim(); persist(); });
    });
    fit();
  }

  /* Scale the 8.5in sheet to fit the preview column. */
  function fit() {
    const frame = $("sheet-frame"), box = $("sheet-scale"), sheet = $("sheet");
    const avail = frame.clientWidth - 40;
    const scale = Math.min(1, avail / sheet.offsetWidth);
    sheet.style.transform = `scale(${scale})`;
    box.style.width = sheet.offsetWidth * scale + "px";
    box.style.height = sheet.offsetHeight * scale + "px";
  }
  window.addEventListener("resize", fit);

  /* Photos: downscale to keep memory + PDF size sane. */
  $("photos").addEventListener("change", async (e) => {
    const files = [...e.target.files].slice(0, 7 - S.photos.length);
    for (const f of files) {
      try { S.photos.push(await shrink(f, 1600)); } catch (err) { console.warn("photo failed", err); }
    }
    e.target.value = "";
    render();
  });
  function shrink(file, max) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(img.src);
        resolve(cv.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  /* Price controls */
  const priceInput = $("list-price"), showSel = $("show-price");
  if (S.listPrice) priceInput.value = S.listPrice;
  showSel.value = S.showPrice ? "yes" : "no";
  $("price-hint").textContent = estimate ? `Our estimate: ${usd(estimate.estimate)} (${usd(estimate.low)}–${usd(estimate.high)})${estimate.sample ? " · sample numbers" : ""}` : "Run the price step to pre-fill this.";
  priceInput.addEventListener("input", () => { S.listPrice = Number(priceInput.value) || null; persist(); render(); });
  showSel.addEventListener("change", () => { S.showPrice = showSel.value === "yes"; persist(); render(); });

  /* PDF: the browser's print dialog → "Save as PDF". The sheet's print CSS handles the rest. */
  $("pdf").addEventListener("click", () => {
    const prev = document.title;
    document.title = (rec.address || `Listing ${rec.zip}`).replace(/[^\w\s-]/g, "").trim() + " - Listing Sheet";
    window.print();
    setTimeout(() => { document.title = prev; }, 500);
  });

  /* Boot */
  render();
  if (S.listing) {
    setMode("demo"); $("mode-pill").textContent = "Saved draft";
    say("bot", "Welcome back! Here's the listing you drafted earlier. Edit it on the sheet, or start the Q&A over.");
    const again = document.createElement("button"); again.type = "button"; again.textContent = "Start over"; again.onclick = start; quick.appendChild(again);
  } else {
    start();
  }
})();
