import { haversineKm } from './watchEngine.js';

/**
 * Rule-based anomaly detection over the position history buffer. Runs after
 * every layer poll, needs no model, and produces a bounded ledger the voice
 * assistant can read back or speak as it happens.
 *
 * Rules: stopped vessel (was under way, now still), rapid descent, orbiting
 * aircraft, impossible position jump (spoofing / bad data), and vessels that
 * went dark after reporting steadily.
 */
export const ANOMALY_STORAGE_KEY = 'gev:voice-anomalies:v1';
export const ANOMALY_KINDS = Object.freeze([
  'stopped_vessel',
  'rapid_descent',
  'orbiting',
  'position_jump',
  'went_dark',
]);
const COOLDOWN_MS = 15 * 60_000;
const MAX_LEDGER = 200;
const MAX_STORED = 60;

const MIN = 60_000;

/** Pure rule evaluation for one entity's fixes (oldest first). */
export function evaluateTrack(
  layerId,
  fixes,
  { now = Date.now(), label = '' } = {},
) {
  const out = [];
  if (!Array.isArray(fixes) || fixes.length < 2) return out;
  const last = fixes[fixes.length - 1];
  const isVessel = layerId === 'ais-live-vessels';

  // Impossible jump between consecutive fixes.
  const limitMps = isVessel ? 60 : 700;
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1];
    const b = fixes[i];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0 || dt > 180) continue;
    const km = haversineKm(a.lat, a.lon, b.lat, b.lon);
    const mps = (km * 1000) / dt;
    if (km > 5 && mps > limitMps) {
      out.push({
        kind: 'position_jump',
        severity: 'high',
        detail: `${Math.round(km)} km in ${Math.round(dt)} s (${Math.round(mps * 1.944)} kt implied)`,
        at: b.t,
      });
      break;
    }
  }

  if (isVessel) {
    // Stopped vessel: moving (> 3 kt) within the last 12 min, still (< 0.6 kt) for 5+ min.
    const recentStill = fixes.filter((f) => last.t - f.t <= 5 * MIN);
    const still =
      recentStill.length >= 3 &&
      recentStill.every((f) => Number.isFinite(f.speed) && f.speed < 0.31) &&
      last.t - recentStill[0].t >= 4 * MIN;
    const wasMoving = fixes.some(
      (f) =>
        last.t - f.t <= 12 * MIN && last.t - f.t > 5 * MIN && f.speed > 1.54,
    );
    if (still && wasMoving)
      out.push({
        kind: 'stopped_vessel',
        severity: 'medium',
        detail: 'was under way, now stopped for 5+ minutes',
        at: last.t,
      });
    // Went dark: reported steadily for 5+ min, then nothing for 8+ min.
    if (now - last.t >= 8 * MIN && fixes.length >= 4) {
      const span = last.t - fixes[0].t;
      const gaps = [];
      for (let i = 1; i < fixes.length; i++)
        gaps.push(fixes[i].t - fixes[i - 1].t);
      const steady = span >= 5 * MIN && Math.max(...gaps) <= 2 * MIN;
      if (steady)
        out.push({
          kind: 'went_dark',
          severity: 'medium',
          detail: `no report for ${Math.round((now - last.t) / MIN)} min after steady updates`,
          at: now,
        });
    }
  } else {
    // Rapid descent: > 900 m lost within 60 s while airborne.
    for (let i = fixes.length - 1; i > 0; i--) {
      const b = fixes[i];
      const a = fixes[i - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt <= 0 || dt > 90) break;
      if (
        Number.isFinite(a.heightM) &&
        Number.isFinite(b.heightM) &&
        b.heightM > 50
      ) {
        const rate = (b.heightM - a.heightM) / dt;
        if (rate < -15) {
          out.push({
            kind: 'rapid_descent',
            severity: 'high',
            detail: `${Math.round(-rate)} m/s down through ${Math.round(b.heightM)} m`,
            at: b.t,
          });
        }
      }
      break;
    }
    // Orbiting: cumulative heading change >= 720° in 10 min with little displacement.
    const window = fixes.filter(
      (f) => last.t - f.t <= 10 * MIN && Number.isFinite(f.headingDeg),
    );
    if (window.length >= 6) {
      let turned = 0;
      for (let i = 1; i < window.length; i++) {
        let d = Math.abs(window[i].headingDeg - window[i - 1].headingDeg) % 360;
        if (d > 180) d = 360 - d;
        turned += d;
      }
      const displacement = haversineKm(
        window[0].lat,
        window[0].lon,
        last.lat,
        last.lon,
      );
      if (turned >= 720 && displacement < 15)
        out.push({
          kind: 'orbiting',
          severity: 'low',
          detail: `${Math.round(turned / 360)} turns within ${Math.round(displacement)} km`,
          at: last.t,
        });
    }
  }
  return out.map((a) => ({
    ...a,
    layerId,
    label,
    lat: last.lat,
    lon: last.lon,
  }));
}

export function createAnomalyEngine({
  dataManager,
  getHistory = () => globalThis.window?.__gevPositionHistory || null,
  layers = ['flights', 'military', 'ais-live-vessels'],
  onAnomaly = () => {},
  storage = safeStorage(),
  now = () => Date.now(),
  maxEntities = 6000,
} = {}) {
  let ledger = load();
  const lastFired = new Map(); // `${layer}:${id}:${kind}` -> t
  let unsubscribe = null;
  let spoken = readFlag(storage, 'gev:voice-anomalies-spoken', true);

  function load() {
    try {
      const raw = storage?.getItem(ANOMALY_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  function save() {
    try {
      storage?.setItem(
        ANOMALY_STORAGE_KEY,
        JSON.stringify(ledger.slice(0, MAX_STORED)),
      );
    } catch {
      /* storage may be unavailable */
    }
  }

  function evaluate(layerId) {
    const history = getHistory();
    if (!history?.entitiesAt || !history?.trackOf) return [];
    const t = now();
    const entities = history.entitiesAt(t - 60_000);
    const found = [];
    let checked = 0;
    for (const entity of entities) {
      if (entity.layerId !== layerId) continue;
      if (++checked > maxEntities) break;
      const fixes = history.trackOf(layerId, entity.id);
      for (const anomaly of evaluateTrack(layerId, fixes, {
        now: t,
        label: entity.label,
      })) {
        const key = `${layerId}:${entity.id}:${anomaly.kind}`;
        const previous = lastFired.get(key) || 0;
        if (t - previous < COOLDOWN_MS) continue;
        lastFired.set(key, t);
        const record = {
          id: `a${t.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
          entityId: entity.id,
          ...anomaly,
          text: describe(anomaly, entity),
          spoken: spoken && anomaly.severity !== 'low',
        };
        ledger.unshift(record);
        found.push(record);
      }
    }
    // Vessels that vanished: present ~10 min ago, absent now.
    if (layerId === 'ais-live-vessels') {
      const earlier = history.entitiesAt(t - 10 * MIN);
      const nowIds = new Set(
        entities.filter((e) => e.layerId === layerId).map((e) => e.id),
      );
      let scanned = 0;
      for (const entity of earlier) {
        if (entity.layerId !== layerId || nowIds.has(entity.id)) continue;
        if (++scanned > 1500) break;
        const fixes = history.trackOf(layerId, entity.id);
        for (const anomaly of evaluateTrack(layerId, fixes, {
          now: t,
          label: entity.label,
        })) {
          if (anomaly.kind !== 'went_dark') continue;
          const key = `${layerId}:${entity.id}:${anomaly.kind}`;
          if (t - (lastFired.get(key) || 0) < COOLDOWN_MS) continue;
          lastFired.set(key, t);
          const record = {
            id: `a${t.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
            entityId: entity.id,
            ...anomaly,
            text: describe(anomaly, entity),
            spoken: spoken && anomaly.severity !== 'low',
          };
          ledger.unshift(record);
          found.push(record);
        }
      }
    }
    if (ledger.length > MAX_LEDGER) ledger.length = MAX_LEDGER;
    if (found.length) {
      save();
      for (const record of found) onAnomaly(record);
    }
    return found;
  }

  return {
    start() {
      if (unsubscribe || typeof dataManager?.subscribeActivity !== 'function')
        return;
      unsubscribe = dataManager.subscribeActivity((event) => {
        if (event?.type === 'data-updated' && layers.includes(event.layerId))
          evaluate(event.layerId);
      });
    },
    evaluate,
    list({ kind = null, minutes = 60, limit = 20 } = {}) {
      const since = now() - minutes * MIN;
      return ledger
        .filter((a) => a.at >= since && (!kind || a.kind === kind))
        .slice(0, limit)
        .map(
          ({
            id,
            kind: k,
            severity,
            layerId,
            entityId,
            label,
            detail,
            at,
            lat,
            lon,
          }) => ({
            id,
            kind: k,
            severity,
            layerId,
            entityId,
            label,
            detail,
            minutesAgo: Math.round((now() - at) / MIN),
            lat,
            lon,
          }),
        );
    },
    setSpoken(enabled) {
      spoken = Boolean(enabled);
      writeFlag(storage, 'gev:voice-anomalies-spoken', spoken);
      return spoken;
    },
    get spoken() {
      return spoken;
    },
    clear() {
      ledger = [];
      lastFired.clear();
      save();
    },
    destroy() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

const KIND_TEXT = {
  stopped_vessel: 'stopped vessel',
  rapid_descent: 'rapid descent',
  orbiting: 'aircraft orbiting',
  position_jump: 'impossible position jump',
  went_dark: 'vessel went dark',
};

export function describe(anomaly, entity) {
  return `${KIND_TEXT[anomaly.kind] || anomaly.kind}: ${entity.label || entity.id}, ${anomaly.detail}.`;
}

function readFlag(storage, key, fallback) {
  try {
    const value = storage?.getItem(key);
    return value == null ? fallback : value !== '0';
  } catch {
    return fallback;
  }
}
function writeFlag(storage, key, value) {
  try {
    storage?.setItem(key, value ? '1' : '0');
  } catch {
    /* no-op */
  }
}
function safeStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
