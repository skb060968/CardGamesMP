export function firebaseArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.keys(value)
    .filter((key) => /^(0|[1-9]\d*)$/.test(key))
    .sort((left, right) => Number(left) - Number(right))
    .map((key) => value[key]);
}
