/**
 * Registry of HTTP routes that local-voice tool packs need on the server
 * (vision batches, radio listening, peer federation, ...). Each entry is a
 * function (middlewares, server) => void that installs its own routes under
 * /api/voice/. Add a pack by importing it here.
 */
import { install as installIncidents } from './incidents.js';

export const FEATURE_ROUTES = Object.freeze([installIncidents]);
import { install as installRadio } from './radio.js';

export const FEATURE_ROUTES = Object.freeze([installRadio]);

export function installFeatureRoutes(middlewares, server) {
  for (const install of FEATURE_ROUTES) install(middlewares, server);
}
