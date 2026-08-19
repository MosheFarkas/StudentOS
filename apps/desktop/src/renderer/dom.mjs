/**
 * The one piece of DOM plumbing everything else is built on.
 *
 * Its own module so it can be tested. It was not, and a bug where every
 * button rendered correctly and was permanently unclickable shipped as a
 * result -- see the note on absent values below.
 */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    /*
     * Skip absent values rather than setting them.
     *
     * setAttribute stringifies, so `disabled: null` writes the literal
     * "null" -- and disabled is a boolean attribute, where any value at all
     * means disabled. Every button written as `disabled: cond ? 'true' : null`
     * was therefore permanently dead, while still rendering perfectly.
     */
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}
