/*
 * nav.js — renders the 1·2·3 progress stepper into <nav class="steps-nav" data-step="N">.
 * Steps you've unlocked are clickable; later steps stay locked until intake is saved.
 * Load after property.js.
 */
(function () {
  const nav = document.querySelector(".steps-nav[data-step]");
  if (!nav) return;
  const current = Number(nav.dataset.step);
  const hasRecord = !!(window.Property && window.Property.load());
  const steps = [
    { n: 1, label: "Your home", href: "intake.html" },
    { n: 2, label: "Price", href: "price.html" },
    { n: 3, label: "Listing", href: "listing.html" },
  ];
  nav.innerHTML = "";
  steps.forEach((s, i) => {
    if (i) { const sep = document.createElement("span"); sep.className = "sep"; sep.setAttribute("aria-hidden", "true"); nav.appendChild(sep); }
    const unlocked = s.n === 1 || hasRecord;
    const isCurrent = s.n === current;
    const el = document.createElement(unlocked && !isCurrent ? "a" : "span");
    if (el.tagName === "A") el.href = s.href;
    if (isCurrent) el.setAttribute("aria-current", "step");
    else if (!unlocked) { el.className = "locked"; el.title = "Fill in your home's details first"; }
    else if (s.n < current || (s.n === 1 && hasRecord)) el.className = "done";
    const done = el.className === "done";
    el.innerHTML = `<span class="dot">${done ? "✓" : s.n}</span><span class="label">${s.label}</span>`;
    nav.appendChild(el);
  });
})();
