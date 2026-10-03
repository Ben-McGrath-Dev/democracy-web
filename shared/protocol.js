export const CLOUD_PROTOCOL_VERSION = 1;

export const CLOUD_MESSAGE = Object.freeze({
  HELLO: 'HELLO',
  WELCOME: 'WELCOME',
  PING: 'PING',
  PONG: 'PONG',
  TIME_SYNC: 'TIME_SYNC',
  ERROR: 'ERROR',
  ROOM_INFO: 'ROOM_INFO',
  PRESENCE: 'PRESENCE',
  AUTH_CHALLENGE: 'AUTH_CHALLENGE',
  AUTH_RESPONSE: 'AUTH_RESPONSE',
  AUTH_OK: 'AUTH_OK',
  JOIN_REQUEST: 'JOIN_REQUEST',
  JOIN_REQUESTS: 'JOIN_REQUESTS',
  JOIN_DECISION: 'JOIN_DECISION',
  JOIN_APPROVED: 'JOIN_APPROVED',
  JOIN_REJECTED: 'JOIN_REJECTED',
  ACTION_SUBMIT: 'ACTION_SUBMIT',
  ACTION_COMMITTED: 'ACTION_COMMITTED',
  STATE_SNAPSHOT: 'STATE_SNAPSHOT',
  RECOVERY_BUNDLE: 'RECOVERY_BUNDLE',
  RESYNC_REQUEST: 'RESYNC_REQUEST',
  RESUME: 'RESUME'
});

export function protocolEnvelope(type, payload = {}, extra = {}) {
  if (!Object.values(CLOUD_MESSAGE).includes(type)) throw new Error(`Unknown cloud protocol message type: ${type}`);
  return { protocol: CLOUD_PROTOCOL_VERSION, type, ...extra, payload };
}

export function parseProtocolMessage(value) {
  const message = typeof value === 'string' ? JSON.parse(value) : value;
  if (!message || typeof message !== 'object') throw new Error('Protocol message must be an object.');
  if (message.protocol !== CLOUD_PROTOCOL_VERSION) throw new Error(`Unsupported protocol version ${message.protocol ?? 'missing'}.`);
  if (!Object.values(CLOUD_MESSAGE).includes(message.type)) throw new Error(`Unsupported protocol message type ${message.type ?? 'missing'}.`);
  return message;
}
