/**
 * Skip the model entirely for the one command people say most: a plain
 * "fly to <known preset city>". Anything richer goes to the model with the
 * full tool set, so this never narrows what the assistant can do.
 */
const DEFAULT_ALIASES = {
  austin: ['austin', 'austin texas'],
  sf: ['sf', 'san francisco', 'san fran', 'frisco'],
  nyc: ['nyc', 'new york', 'new york city', 'manhattan'],
  tokyo: ['tokyo'],
  london: ['london'],
  paris: ['paris'],
  dubai: ['dubai'],
  dc: ['dc', 'washington', 'washington dc', 'washington d.c.', 'd.c.'],
};

const LABELS = {
  austin: 'Austin',
  sf: 'San Francisco',
  nyc: 'New York City',
  tokyo: 'Tokyo',
  london: 'London',
  paris: 'Paris',
  dubai: 'Dubai',
  dc: 'Washington DC',
};

/** Human label for a preset id, for canned confirmations. */
export function flyToLabel(id) {
  if (LABELS[id]) return LABELS[id];
  const text = String(id || '');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const VERB =
  /^(?:(?:please|ok|okay|hey|now|can you|could you)\s+)*(?:fly|go|take me|bring me|jump|navigate|head|travel|move)\s+(?:us\s+)?(?:over\s+)?(?:to|towards|toward)\s+(?:the\s+city\s+of\s+)?(?<place>[a-z. ]+?)(?:\s+please)?$/;

export function deterministicFlyTo(
  text,
  {
    locationIds = Object.keys(DEFAULT_ALIASES),
    aliases = DEFAULT_ALIASES,
  } = {},
) {
  const value = normalize(text);
  if (!value) return null;
  const match = VERB.exec(value);
  if (!match) return null;
  const place = match.groups.place.replace(/\.$/, '').trim();
  for (const id of locationIds) {
    const names = aliases[id] || [id];
    if (names.some((name) => normalize(name) === place))
      return { name: 'fly_to_location', arguments: { locationId: id } };
  }
  return null;
}

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[,!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');
}
