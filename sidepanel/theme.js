// Applies the saved theme before the panel paints, so a forced light/dark choice never
// flashes the other palette. Loaded as a blocking script in <head> (MV3 forbids inline scripts).
(function () {
  let mode = "system";
  try { mode = localStorage.getItem("nexusTheme") || "system"; } catch { /* storage blocked */ }
  if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode;
})();
