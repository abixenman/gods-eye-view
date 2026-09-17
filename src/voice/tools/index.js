/**
 * Registry of local-voice tool packs. Each pack exports `schemas` (tool
 * definitions in the same shape as localToolSchemas.js) and
 * `createHandlers(context)` returning { toolName: async (args) => result }.
 * The context carries { memory, watches, getGlobe, getTimeTravel, runner,
 * captureImage, speak(text), fetchJson(url, body) }.
 *
 * Add a pack by importing it here; nothing else needs to change.
 */
import * as watchkeeping from './watchkeeping.js';
import * as prediction from './prediction.js';

export const LOCAL_TOOL_PACKS = Object.freeze([watchkeeping, prediction]);

export function packSchemas() {
  return LOCAL_TOOL_PACKS.flatMap((pack) => pack.schemas || []);
}

export function packHandlers(context) {
  const handlers = {};
  for (const pack of LOCAL_TOOL_PACKS)
    Object.assign(handlers, pack.createHandlers?.(context) || {});
  return handlers;
}
