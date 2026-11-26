// Settings are shared by native windows. Pending local changes stay visible
// while another window's snapshot is in flight.
async function openPreferences(bridge, legacy) {
  const keys = new Set(("view theme editorFont zoom split sync gutter wrap measure autosave " +
    "pairing linkPaste htmlPaste tablePaste confirmImage readingTime focusParagraph typewriter " +
    "lineBreaks formatBar darkExport pageNumbers autoUpdate").split(" "));
  const seed = {};
  for (const key of keys) {
    const value = legacy.get(key);
    if (value !== undefined) seed[key] = value;
  }
  let confirmed = seed, revision = -1, writable = false, warning = null;
  let queue = Promise.resolve(), changed = () => {}, failed = () => {};
  const pending = new Map();
  const current = key => pending.has(key) ? pending.get(key) : confirmed[key];
  function receive(snapshot) {
    if (snapshot.revision <= revision) return;
    const before = new Map([...keys].map(key => [key, current(key)]));
    confirmed = snapshot.values;
    revision = snapshot.revision;
    for (const key of keys) if (before.get(key) !== current(key)) changed(key);
  }
  try {
    await bridge.event.listen("preferences-changed", event => receive(event.payload));
    receive(await bridge.core.invoke("read_preferences", {seed}));
    writable = true;
    for (const key of keys) legacy.remove(key);
  } catch (error) {
    warning = "Settings could not be loaded. Changes will last for this window only. " + error;
  }
  return {
    keys, warning,
    subscribe(onChange, onError) { changed = onChange; failed = onError; },
    get(key, fallback) { return current(key) ?? fallback; },
    set(key, value) {
      if (current(key) === value) return;
      pending.set(key, value);
      if (!writable) return;
      queue = queue.then(async () => {
        // A later input already superseded this write.
        if (pending.get(key) !== value) return;
        try {
          receive(await bridge.core.invoke("set_preference", {key, value}));
        } catch (error) {
          failed("Could not save this setting. " + error);
        } finally {
          if (pending.get(key) === value) {
            pending.delete(key);
            if (current(key) !== value) changed(key);
          }
        }
      });
    },
    flush() { return queue; },
  };
}
