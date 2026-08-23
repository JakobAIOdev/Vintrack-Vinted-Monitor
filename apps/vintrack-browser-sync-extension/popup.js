const container = document.getElementById("vintrack-companion");

if (!globalThis.VintrackCompanion?.mount) {
  container.textContent = "Vintrack Companion could not be loaded.";
} else {
  globalThis.VintrackCompanion.mount(container, { surface: "popup" });
}
