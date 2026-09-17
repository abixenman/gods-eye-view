/**
 * Registry of HTTP routes that local-voice tool packs need on the server
 * (vision batches, radio listening, peer federation, ...). Each entry is a
 * function (middlewares, server) => void that installs its own routes under
 * /api/voice/. Add a pack by importing it here.
 */
import { install as installSpeaker } from './speaker.js';

export const FEATURE_ROUTES = Object.freeze([installSpeaker]);

export function installFeatureRoutes(middlewares, server) {
  for (const install of FEATURE_ROUTES) install(middlewares, server);
}
