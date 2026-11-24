// The wordmark is navy with a teal dot, drawn for light backgrounds. The dark
// theme uses the same drawing with colours that keep their contrast on the
// dark preview. scripts/build-brand.mjs writes the result.
export const LIGHT = { ink: "#113661", dot: "#349598" };
export const DARK = { ink: "#E3EAF3", dot: "#4DB3B5" };

export function darkWordmark(svg) {
  const swap = (text, from, to) => {
    const pattern = new RegExp(`fill="${from}"`, "gi");
    if ((text.match(pattern) || []).length !== 1) throw Error(`Expected one ${from} fill in the wordmark`);
    return text.replace(pattern, `fill="${to}"`);
  };
  return swap(swap(svg, LIGHT.ink, DARK.ink), LIGHT.dot, DARK.dot);
}
