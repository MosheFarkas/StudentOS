/**
 * Filling in a sign-in form, wherever it is being filled in.
 *
 * One implementation so the browser the student watches and any other path
 * cannot drift into signing in differently -- a difference that would show up
 * as "it worked when I tested it" and nowhere else.
 */

/**
 * Build the expression that types a sign-in into whatever form is on the page.
 *
 * @returns {string} JavaScript to evaluate in the page.
 */
export function fillScript(username, password) {
  return `(() => {
    const pw = document.querySelector('input[type=password]');
    if (!pw) return 'no-password-field';
    const form = pw.form ?? document;
    const inputs = Array.from(form.querySelectorAll('input'));
    const before = inputs.slice(0, inputs.indexOf(pw)).reverse();
    const user = before.find((i) => /^(text|email|tel)$/.test(i.type) && !i.disabled)
      ?? form.querySelector('input[type=email], input[type=text]');
    if (!user) return 'no-username-field';
    // Assigning .value is invisible to React, which tracks its own state, so
    // the form would submit empty. Going through the prototype setter and
    // firing the events is what a real keystroke looks like.
    const set = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter ? setter.call(el, value) : (el.value = value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(user, ${JSON.stringify(username)});
    set(pw, ${JSON.stringify(password)});
    const submit = form.querySelector('button[type=submit], input[type=submit]')
      ?? Array.from(form.querySelectorAll('button')).find((b) => !b.type || b.type === 'submit');
    if (submit) submit.click();
    else if (form.requestSubmit) form.requestSubmit();
    else if (form.submit) form.submit();
    return 'submitted';
  })()`;
}

/** Whether the page is still asking to be signed in, and where it ended up. */
export const INSPECT_SCRIPT = `JSON.stringify({
  stillAsking: Boolean(document.querySelector('input[type=password]')),
  landed: location.href
})`;

/** What went wrong, in words a student can act on. */
export function explainFailure(code) {
  return (
    {
      'no-password-field': 'that address has no sign-in form on it',
      'no-username-field': 'the sign-in form there has no username box this could fill',
    }[code] ?? 'the sign-in form could not be filled in'
  );
}
