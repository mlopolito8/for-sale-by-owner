/*
 * property.js — the shared property-record contract.
 *
 * The intake form writes this record; price.html and listing.html read it.
 * FIELD NAMES ARE FROZEN once the team agrees on them. Add fields freely,
 * but don't rename or remove one without telling everyone.
 *
 * Stored in localStorage as JSON under STORAGE_KEY.
 */
(function () {
  const STORAGE_KEY = "fsbo.property.v1";
  const THIS_YEAR = new Date().getFullYear();

  // `required: true` = needed by the price estimator.
  const GROUPS = [
    {
      id: "location", title: "Location",
      fields: [
        { name: "address", label: "Street address", type: "text", hint: "Optional. Used in the listing, not the estimate." },
        { name: "zip", label: "ZIP code", type: "text", required: true, pattern: "\\d{5}", inputmode: "numeric", maxlength: 5 },
        { name: "neighborhood", label: "Neighborhood", type: "text" },
        { name: "county", label: "County", type: "text" },
        { name: "schoolDistrict", label: "School district", type: "text" },
      ],
    },
    {
      id: "basics", title: "Basics",
      fields: [
        { name: "propertyType", label: "Property type", type: "select", required: true,
          options: [["single-family", "Single-family"], ["condo", "Condo"], ["townhome", "Townhome"], ["multi-family", "Multi-family"]] },
        { name: "bedrooms", label: "Bedrooms", type: "number", required: true, min: 0, max: 20, step: 1 },
        { name: "bathrooms", label: "Bathrooms", type: "number", required: true, min: 0.5, max: 20, step: 0.5 },
        { name: "sqft", label: "Living area (sq ft)", type: "number", required: true, min: 1, step: 1 },
        { name: "lotSizeAcres", label: "Lot size (acres)", type: "number", min: 0, step: 0.01 },
        { name: "stories", label: "Stories", type: "number", min: 1, max: 10, step: 1 },
      ],
    },
    {
      id: "structure", title: "Structure",
      fields: [
        { name: "yearBuilt", label: "Year built", type: "number", required: true, min: 1700, max: THIS_YEAR, step: 1 },
        { name: "basement", label: "Basement", type: "select",
          options: [["none", "None"], ["unfinished", "Unfinished"], ["finished", "Finished"]] },
        { name: "exteriorSiding", label: "Exterior siding", type: "text", hint: "e.g. vinyl, brick, wood shingle" },
        { name: "roofAgeYears", label: "Roof age (years)", type: "number", min: 0, max: 100, step: 1 },
      ],
    },
    {
      id: "purchase", title: "Purchase history",
      fields: [
        { name: "pricePaid", label: "Price you paid ($)", type: "number", required: true, min: 1, step: 1 },
        { name: "purchaseMonth", label: "Month bought", type: "select", required: true,
          options: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map((m, i) => [String(i + 1), m]) },
        { name: "purchaseYear", label: "Year bought", type: "number", required: true, min: 2000, max: THIS_YEAR, step: 1,
          hint: "2000 or later (Zillow's ZIP history starts in 2000)." },
      ],
    },
    {
      id: "features", title: "Features",
      fields: [
        { name: "flooring", label: "Flooring", type: "text", hint: "e.g. hardwood, tile, carpet" },
        { name: "hvacType", label: "Heating / cooling", type: "text", hint: "e.g. forced air gas, heat pump" },
        { name: "kitchenUpdatedYear", label: "Kitchen last updated (year)", type: "number", min: 1900, max: THIS_YEAR, step: 1 },
        { name: "parking", label: "Garage / parking", type: "text", hint: "e.g. 2-car attached garage" },
        { name: "amenities", label: "Amenities", type: "checkboxes",
          options: [["pool", "Pool"], ["deck-patio", "Deck / patio"], ["fireplace", "Fireplace"], ["central-ac", "Central AC"],
                    ["ev-charger", "EV charger"], ["solar", "Solar panels"], ["fenced-yard", "Fenced yard"], ["laundry", "In-unit laundry"]] },
      ],
    },
    {
      id: "costs", title: "Costs",
      fields: [
        { name: "annualPropertyTax", label: "Annual property tax ($)", type: "number", min: 0, step: 1 },
        { name: "hoaMonthly", label: "HOA dues ($/month)", type: "number", min: 0, step: 1 },
        { name: "utilitiesMonthly", label: "Typical utilities ($/month)", type: "number", min: 0, step: 1 },
      ],
    },
  ];

  const FIELDS = GROUPS.flatMap((g) => g.fields);

  /** Coerce raw form values into the stored types. Empty optional fields are omitted. */
  function normalize(raw) {
    const out = {};
    for (const f of FIELDS) {
      let v = raw[f.name];
      if (f.type === "checkboxes") {
        out[f.name] = Array.isArray(v) ? v : [];
        continue;
      }
      if (v === undefined || v === null || String(v).trim() === "") continue;
      v = String(v).trim();
      if (f.type === "number" || f.name === "purchaseMonth") v = Number(v);
      out[f.name] = v;
    }
    return out;
  }

  /** Returns { fieldName: "error message" }. Empty object = valid. */
  function validate(rec) {
    const errors = {};
    for (const f of FIELDS) {
      const v = rec[f.name];
      const missing = v === undefined;
      if (f.required && missing) { errors[f.name] = "Required."; continue; }
      if (missing) continue;
      if (f.type === "number") {
        if (!Number.isFinite(v)) errors[f.name] = "Enter a number.";
        else if (f.min !== undefined && v < f.min) errors[f.name] = `Must be at least ${f.min}.`;
        else if (f.max !== undefined && v > f.max) errors[f.name] = `Must be ${f.max} or less.`;
        else if (f.step === 1 && !Number.isInteger(v)) errors[f.name] = "Whole numbers only.";
      }
    }
    if (rec.zip !== undefined && !/^\d{5}$/.test(rec.zip)) errors.zip = "Enter a 5-digit ZIP.";
    // Purchase date can't be in the future.
    if (!errors.purchaseYear && !errors.purchaseMonth && rec.purchaseYear && rec.purchaseMonth) {
      const now = new Date();
      if (rec.purchaseYear === now.getFullYear() && rec.purchaseMonth > now.getMonth() + 1) {
        errors.purchaseMonth = "Purchase date can't be in the future.";
      }
    }
    if (rec.yearBuilt && rec.purchaseYear && rec.purchaseYear < rec.yearBuilt - 2) {
      errors.purchaseYear = "Bought before it was built? Check the years.";
    }
    return errors;
  }

  function save(rec) {
    const stamped = { ...rec, schemaVersion: 1, updatedAt: new Date().toISOString() };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stamped)); return true; }
    catch (e) { console.warn("Could not save property record", e); return false; }
  }

  function load() {
    try { const s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; }
    catch (e) { return null; }
  }

  function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  /** Human-readable label for a select/checkbox value. */
  function labelFor(fieldName, value) {
    const f = FIELDS.find((x) => x.name === fieldName);
    if (!f || !f.options) return value;
    const opt = f.options.find(([v]) => String(v) === String(value));
    return opt ? opt[1] : value;
  }

  window.Property = { STORAGE_KEY, GROUPS, FIELDS, normalize, validate, save, load, clear, labelFor };
})();
