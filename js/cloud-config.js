export const CLOUD_BACKEND = Object.freeze({
  enabled: true,
  // Local development default. Production invite links carry the deployed Worker URL
  // so new browsers do not need to configure it manually before joining.
  apiBase: 'http://localhost:8787',
  protocol: 1
});
