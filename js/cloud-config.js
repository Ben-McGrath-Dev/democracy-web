export const CLOUD_BACKEND = Object.freeze({
  enabled: true,
  // Production default for this deployment. Local development automatically falls back
  // to http://localhost:8787 when the frontend itself is running on localhost and no
  // browser-saved backend override exists.
  apiBase: 'https://democracy-web-cloud.ben-mcgrath-dev.workers.dev',
  protocol: 1
});
