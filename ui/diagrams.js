// Mermaid diagrams as images. The engine is a large bundle, so it is loaded
// the first time a document needs it. Every diagram is drawn with the engine's
// strict security level and then shown through an `img` element, where an SVG
// cannot run script, follow links or load other resources.
const KladjeDiagrams = (() => {
  const MAX_SOURCE = 50000; // UTF-16 code units in one diagram
  const MAX_CACHE = 64;
  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';

  /** Turn the engine's SVG markup into a sized image source. */
  function svgImage(svg) {
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = parsed.documentElement;
    if (!root || root.nodeName !== "svg" || parsed.querySelector("parsererror")) {
      throw Error("The diagram could not be drawn.");
    }
    // An image needs its own dimensions. The engine states them in the viewBox.
    const box = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    if (box.length !== 4 || !(box[2] > 0) || !(box[3] > 0)) throw Error("The diagram could not be drawn.");
    const width = Math.ceil(box[2]), height = Math.ceil(box[3]);
    root.setAttribute("width", String(width));
    root.setAttribute("height", String(height));
    root.removeAttribute("style");
    const bytes = new TextEncoder().encode(new XMLSerializer().serializeToString(root));
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { src: "data:image/svg+xml;base64," + btoa(binary), width, height };
  }

  const reason = (error) => {
    const text = String((error && error.message) || error || "").split("\n")[0].trim();
    return text.slice(0, 200) || "The diagram could not be drawn.";
  };

  /**
   * `loadEngine()` resolves to the Mermaid API. `toImage` is replaceable for tests.
   * `image(source, dark)` resolves to `{src, width, height}` or `{error}` and never rejects.
   */
  function create(loadEngine, toImage = svgImage) {
    const cache = new Map(); // theme + source -> promise of a result
    let engine = null, queue = Promise.resolve(), serial = 0;

    async function draw(source, dark) {
      if (source.length > MAX_SOURCE) return { error: "This diagram is too large to draw." };
      try {
        engine = engine || await loadEngine();
      } catch (error) {
        return { error: reason(error), unavailable: true };
      }
      try {
        // The engine keeps one global configuration. Drawings run one at a time.
        engine.initialize({
          startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default",
          htmlLabels: false, flowchart: { htmlLabels: false }, suppressErrorRendering: true,
          fontFamily: FONT, logLevel: "fatal",
        });
        const { svg } = await engine.render("kladje-diagram-" + ++serial, source);
        return toImage(svg);
      } catch (error) {
        return { error: reason(error) };
      }
    }

    function image(source, dark = false) {
      const key = (dark ? "dark\n" : "light\n") + source;
      let result = cache.get(key);
      if (result) {
        cache.delete(key); // keep recently used entries
      } else {
        result = queue.then(() => draw(source, dark));
        queue = result;
        // A missing engine may be installed later. Do not remember that answer.
        result.then((value) => { if (value.unavailable && cache.get(key) === result) cache.delete(key); });
      }
      cache.set(key, result);
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
      return result;
    }

    return { image };
  }

  return { create, svgImage };
})();

if (typeof module !== "undefined") module.exports = KladjeDiagrams;
