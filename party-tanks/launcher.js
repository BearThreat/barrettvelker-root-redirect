const URL_MODES = {
  live: {
    label: "Live friend-test links",
    base: "https://blackbear.tail0b3173.ts.net:14443"
  },
  local: {
    label: "Local Blackbear dev links",
    base: "http://127.0.0.1:8787"
  }
};

const ROUTES = {
  tv: "/tv.html?room=TANK7",
  controller: "/controller.html?room=TANK7",
  join: "/join.html?room=TANK7",
  actions: "/debug/actions?roomId=TANK7&limit=200&currentBuild=true"
};

const params = new URLSearchParams(window.location.search);
const savedMode = window.localStorage.getItem("partyTanksUrlMode");
const initialMode = URL_MODES[params.get("mode")] ? params.get("mode") : savedMode || "live";

setMode(initialMode);

for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}

function setMode(mode) {
  const selected = URL_MODES[mode] ? mode : "live";
  const config = URL_MODES[selected];
  window.localStorage.setItem("partyTanksUrlMode", selected);
  document.getElementById("modeStatus").textContent = config.label;
  document.getElementById("baseUrl").textContent = config.base;
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === selected));
  }
  for (const link of document.querySelectorAll("[data-route]")) {
    const route = ROUTES[link.dataset.route];
    if (route) link.href = `${config.base}${route}`;
  }
}
