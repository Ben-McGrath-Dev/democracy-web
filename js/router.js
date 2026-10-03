const routes = new Map();
let currentRoute = 'home';

export function registerRoute(name, renderer) {
  routes.set(name, renderer);
}

export function navigate(name) {
  if (!routes.has(name)) name = 'home';
  currentRoute = name;
  history.replaceState({}, '', `#${name}`);
  renderCurrentRoute();
}

export function renderCurrentRoute() {
  const route = location.hash.replace('#', '') || currentRoute || 'home';
  currentRoute = routes.has(route) ? route : 'home';
  const view = document.querySelector('#view');
  view.innerHTML = routes.get(currentRoute)();
  view.focus({ preventScroll: true });

  document.querySelectorAll('[data-route]').forEach(btn => {
    const active = btn.dataset.route === currentRoute;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
  });

  document.dispatchEvent(new CustomEvent('route:rendered', { detail: { route: currentRoute } }));
}

export function initRouter() {
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-route]');
    if (!target) return;
    event.preventDefault();
    navigate(target.dataset.route);
  });
  window.addEventListener('hashchange', renderCurrentRoute);
}
