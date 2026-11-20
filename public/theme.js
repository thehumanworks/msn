// Light or dark theme (ADR 0049). A classic, render-blocking script so a forced theme applies
// before the first paint. With no choice saved, the CSS follows the system setting; a choice is
// kept on this device only (localStorage "msn.theme"), survives Disconnect, and the server never
// learns it.
(() => {
  const KEY = "msn.theme";
  const BAR = { dark: "#0b0b0e", light: "#f7f7f9" };
  const root = document.documentElement;
  const system = window.matchMedia("(prefers-color-scheme: light)");

  const saved = () => {
    try {
      const value = localStorage.getItem(KEY);
      return value === "light" || value === "dark" ? value : "";
    } catch {
      return "";
    }
  };

  function apply(choice) {
    if (choice) root.dataset.theme = choice;
    else delete root.dataset.theme;
    // The browser bar matches the page, not the system, when this device forces a theme.
    const shown = choice || (system.matches ? "light" : "dark");
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = BAR[shown];
  }

  function choose(choice) {
    try {
      if (choice) localStorage.setItem(KEY, choice);
      else localStorage.removeItem(KEY);
    } catch {}
    apply(choice);
  }

  apply(saved());
  system.addEventListener("change", () => apply(saved()));
  // Another tab changed the choice: follow it here too.
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) {
      apply(saved());
      const select = document.getElementById("theme");
      if (select) select.value = saved();
    }
  });
  document.addEventListener("DOMContentLoaded", () => {
    apply(saved());
    const select = document.getElementById("theme");
    if (!select) return;
    select.value = saved();
    select.addEventListener("change", () =>
      choose(select.value === "light" || select.value === "dark" ? select.value : ""),
    );
  });
})();
