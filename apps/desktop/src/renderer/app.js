/*
 * The window.
 *
 * Plain DOM, and every piece of text set with textContent rather than
 * innerHTML. Portal names come from what the student typed and portal errors
 * come from a school's server, so neither is markup this app should evaluate.
 */

import { el } from './dom.mjs';

const app = document.getElementById('app');
const busy = new Set();

/** Every call returns {ok, value|error}; this surfaces the message, not a crash. */
async function call(fn, key) {
  busy.add(key);
  render();
  const result = await fn();
  busy.delete(key);
  if (!result.ok) alert(result.error);
  await render();
  return result;
}

function ago(iso) {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 2) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function portalRow(portal) {
  const syncing = busy.has(`sync:${portal.id}`);
  const result = portal.lastResult;

  const detail = !portal.loggedInAt
    ? 'Not signed in yet'
    : result
      ? `${
          result.withData === 0
            ? 'connected, nothing published yet'
            : `${result.withData} of ${result.components} data sources have content`
        } · synced ${ago(portal.lastSyncedAt)}`
      : 'Signed in, never synced';

  // The address is discovered after signing in, not taken from what was typed,
  // so showing it is how a student can tell it found the right place.
  const address = portal.loggedInAt ? portal.origin : null;

  const actions = !portal.loggedInAt
    ? [
        el('button', {
          text: busy.has(`login:${portal.id}`) ? 'Opening…' : 'Sign in',
          disabled: busy.has(`login:${portal.id}`) ? 'true' : null,
          onclick: () => void beginLogin(portal),
        }),
      ]
    : [
        el('button', {
          class: 'primary',
          text: syncing ? 'Syncing…' : 'Sync now',
          disabled: syncing ? 'true' : null,
          onclick: () =>
            void call(() => window.contexto.syncPortal(portal.id), `sync:${portal.id}`),
        }),
      ];

  actions.push(
    el('button', {
      text: 'Remove',
      onclick: () => {
        if (confirm(`Remove ${portal.name}?`)) {
          void call(() => window.contexto.removePortal(portal.id), `rm:${portal.id}`);
        }
      },
    }),
  );

  return el('div', { class: 'portal' }, [
    el('div', { class: 'between' }, [
      el('div', {}, [
        el('div', { text: portal.name }),
        el('div', { class: 'muted small', text: detail }),
        address ? el('div', { class: 'muted small', text: address }) : null,
      ]),
      el('div', { class: 'row' }, actions),
    ]),
    portal.lastError && !syncing
      ? el('div', { class: 'notice', text: `Last sync failed: ${portal.lastError}` })
      : null,
    result && result.needsLogin
      ? el('div', {
          class: 'notice',
          text: 'That site asked for a sign-in, so the saved session has expired. Sign in again.',
        })
      : null,
    result && !result.needsLogin && result.withData === 0
      ? el('div', {
          class: 'notice',
          text:
            'Connected, but the site is not publishing anything yet. The session is still good — ' +
            'there is genuinely nothing there to read.',
        })
      : null,
    result && !result.complete
      ? el('div', {
          class: 'notice',
          text: 'Stopped at the page limit, so some pages were not read.',
        })
      : null,
  ]);
}

/** Two steps, because nothing outside the browser can tell when a login finished. */
async function beginLogin(portal) {
  const started = await call(() => window.contexto.beginLogin(portal.id), `login:${portal.id}`);
  if (!started.ok) return;

  const done = el('div', { class: 'panel' }, [
    el('h2', { text: `Signing in to ${portal.name}` }),
    el('p', {
      class: 'muted small',
      text:
        'A browser window is open. Sign in the way you normally would, including two-factor. ' +
        'Then come back here.',
    }),
    el('button', {
      class: 'primary',
      text: "I'm signed in",
      onclick: async () => {
        const finished = await call(
          () => window.contexto.finishLogin(portal.id),
          `finish:${portal.id}`,
        );
        // Syncing after a sign-in that did not take just records an empty
        // portal, which reads to the student as "there is nothing here".
        if (finished.ok && finished.value?.needsLogin) {
          const { cookies = 0, google = false } = finished.value;
          alert(
            cookies <= 2 && !google
              ? 'No sign-in happened in the window ContextoAgent opened.\n\n' +
                  'That window is a separate Chrome profile — it looks exactly like your ' +
                  'normal browser but is signed out of everything, including Google. ' +
                  'Being signed in elsewhere does not count.\n\n' +
                  'Open it again and sign in inside that window, all the way through Google, ' +
                  'until you can see your courses.'
              : 'The site still asks for a password after signing in. It may have rejected the ' +
                  'login, or it signs you out again straight away.',
          );
          return;
        }
        await call(() => window.contexto.syncPortal(portal.id), `sync:${portal.id}`);
      },
    }),
  ]);
  app.replaceChildren(done);
}

function addPortalPanel() {
  const name = el('input', { placeholder: 'Veracross', 'aria-label': 'Site name' });
  const url = el('input', {
    placeholder: 'https://portals.veracross.com/lcc/student',
    'aria-label': 'Site address',
  });

  return el('div', { class: 'panel' }, [
    el('h2', { text: 'Add a site' }),
    el('p', {
      class: 'muted small',
      text: 'The page you normally land on after signing in — not the sign-in page itself. Copy it from your browser.',
    }),
    el('div', { class: 'row' }, [name, url]),
    el('div', { class: 'row', style: 'margin-top:.6rem' }, [
      el('button', {
        class: 'primary',
        text: 'Add',
        onclick: () => {
          if (!name.value.trim() || !url.value.trim()) return alert('Both fields are needed.');
          void call(
            () => window.contexto.addPortal({ name: name.value.trim(), url: url.value.trim() }),
            'add',
          );
        },
      }),
    ]),
  ]);
}

/**
 * Opening at login is what makes this a sync utility rather than something
 * you have to remember to run. Offered rather than assumed -- an app that
 * quietly adds itself to startup is one people uninstall.
 */
function startupPanel(openAtLogin) {
  const box = el('input', { type: 'checkbox', id: 'open-at-login' });
  if (openAtLogin) box.setAttribute('checked', 'checked');
  box.addEventListener('change', () => {
    void call(() => window.contexto.setOpenAtLogin(box.checked), 'startup');
  });

  return el('div', { class: 'panel' }, [
    el('div', { class: 'row' }, [
      box,
      el('label', {
        for: 'open-at-login',
        text: 'Open at login and keep these sites up to date in the background',
      }),
    ]),
  ]);
}

async function render() {
  const result = await window.contexto.status();
  if (!result.ok) return app.replaceChildren(el('p', { text: result.error }));
  const { linked, deviceName, portals, openAtLogin } = result.value;

  if (!linked) {
    return app.replaceChildren(
      el('div', {}, [
        el('h1', { text: 'ContextoAgent' }),
        el('p', {
          class: 'muted',
          text: 'Reads sites that need a login — school portals, course pages, anything behind a sign-in — using the logins you complete yourself.',
        }),
        el('div', { class: 'panel' }, [
          el('h2', { text: 'Link this computer' }),
          el('p', {
            class: 'muted small',
            text:
              'Opens your browser so you can approve it from your account. ' +
              'Nothing is read until you add a site and sign in.',
          }),
          el('button', {
            class: 'primary',
            text: busy.has('link') ? 'Waiting for approval…' : 'Link this computer',
            disabled: busy.has('link') ? 'true' : null,
            onclick: () => void call(() => window.contexto.link(), 'link'),
          }),
        ]),
      ]),
    );
  }

  app.replaceChildren(
    el('div', {}, [
      el('h1', { text: 'ContextoAgent' }),
      el('p', { class: 'muted small', text: `Linked as ${deviceName ?? 'this computer'}` }),
      portals.length > 0
        ? el('div', { class: 'panel' }, [el('h2', { text: 'Sites' }), ...portals.map(portalRow)])
        : null,
      addPortalPanel(),
      startupPanel(openAtLogin),
    ]),
  );
}

window.contexto.onPortalsChanged(() => void render());
void render();
