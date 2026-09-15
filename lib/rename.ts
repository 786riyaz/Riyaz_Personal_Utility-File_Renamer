export function getExtension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

export function forceSameExtension(original: string, proposed: string) {
  const ext = getExtension(original);
  const dot = proposed.lastIndexOf(".");
  const base = dot > 0 ? proposed.slice(0, dot) : proposed;
  return `${base}${ext}`;
}

export function isWindowsSafeName(name: string) {
  return !!name && !/[\\/:*?"<>|]/.test(name) && !/[. ]$/.test(name);
}

/** Natural sorting: Title 2 comes before Title 10. */
export function naturalCompare(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}
