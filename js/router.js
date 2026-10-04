const routes = new Map();
const detailRoutes = new Map();
let currentRoute = 'home';
const scrollPositions = new Map();

function cleanRoute(value) {
  return String(value ?? '').replace(/^#/, '').trim().replace(/^\/+|\/+$/g, '');
}

function resolveRoute(rawValue) {
  const raw = cleanRoute(rawValue);
  if (routes.has(raw)) return { route: raw, key: raw, renderer: routes.get(raw), parent: raw, params: {} };
  const slash = raw.indexOf('/');
  if (slash > 0) {
    const prefix = raw.slice(0, slash);
    const config = detailRoutes.get(prefix);
    if (config) {
      const id = decodeURIComponent(raw.slice(slash + 1));
      if (id) return { route: raw, key: prefix, renderer: config.renderer, parent: config.parent, params: { id } };
    }
  }
  return routes.has('home') ? { route: 'home', key: 'home', renderer: routes.get('home'), parent: 'home', params: {} } : null;
}

function routeFromLocation() {
  const raw = cleanRoute(location.hash);
  return resolveRoute(raw)?.route ?? 'home';
}

function rememberScroll(route = currentRoute) {
  if (!route) return;
  scrollPositions.set(route, window.scrollY || document.documentElement.scrollTop || 0);
}

export function registerRoute(name, renderer) {
  routes.set(name, renderer);
}

export function registerDetailRoute(prefix, parent, renderer) {
  detailRoutes.set(prefix, { parent, renderer });
}

export function getCurrentRoute() {
  return currentRoute;
}

export function getRouteParent(route = currentRoute) {
  return resolveRoute(route)?.parent ?? route;
}

export function navigate(name, { replace = false, restoreScroll = false } = {}) {
  const resolved = resolveRoute(name);
  if (!resolved) name = 'home'; else name = resolved.route;
  const previous = currentRoute;
  rememberScroll(previous);
  currentRoute = name;
  const url = `#${name}`;
  if (replace || location.hash === url) history.replaceState({ route: name }, '', url);
  else history.pushState({ route: name }, '', url);
  renderCurrentRoute({ restoreScroll, previousRoute: previous });
}

export function renderCurrentRoute({ restoreScroll = false, previousRoute = null } = {}) {
  const resolved = resolveRoute(routeFromLocation() || currentRoute || 'home');
  currentRoute = resolved?.route ?? 'home';
  const view = document.querySelector('#view');
  const renderer = resolved?.renderer ?? routes.get('home');
  view.innerHTML = renderer(resolved?.params ?? {}, resolved ?? {});
  view.focus({ preventScroll: true });

  document.querySelectorAll('[data-route]').forEach(btn => {
    const target = cleanRoute(btn.dataset.route);
    const active = target === currentRoute || target === resolved?.parent;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
  });

  const heading = view.querySelector('h1');
  document.title = heading?.textContent?.trim() ? `${heading.textContent.trim()} — Democracy Web` : 'Democracy Web';

  requestAnimationFrame(() => {
    const top = restoreScroll ? (scrollPositions.get(currentRoute) ?? 0) : 0;
    window.scrollTo({ top, left: 0, behavior: 'auto' });
  });

  document.dispatchEvent(new CustomEvent('route:rendered', { detail: { route: currentRoute, parentRoute: resolved?.parent ?? currentRoute, previousRoute, restoreScroll, params: resolved?.params ?? {} } }));
}

export function initRouter() {
  currentRoute = routeFromLocation();
  if (location.hash) history.replaceState({ route: currentRoute }, '', `#${currentRoute}`);
  else history.replaceState({ route: currentRoute }, '', `${location.pathname}${location.search}`);
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-route]');
    if (!target) return;
    event.preventDefault();
    navigate(target.dataset.route);
  });
  window.addEventListener('popstate', () => {
    const previous = currentRoute;
    rememberScroll(previous);
    renderCurrentRoute({ restoreScroll: true, previousRoute: previous });
  });
  window.addEventListener('hashchange', () => {
    if (routeFromLocation() === currentRoute) return;
    const previous = currentRoute;
    rememberScroll(previous);
    renderCurrentRoute({ restoreScroll: true, previousRoute: previous });
  });
}
