/*
 * The window.
 *
 * Plain DOM, and every piece of text set with textContent rather than
 * innerHTML. Portal names come from what the student typed and portal errors
 * come from a school's server, so neither is markup this app should evaluate.
 */

const app = document.getElementById('app');
const busy = new Set();

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

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
      ? `${result.withData} of ${result.components} components had data · synced ${ago(portal.lastSyncedAt)}`
      : 'Signed in, never synced';

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
          onclick: () => void call(() => window.contexto.syncPortal(portal.id), `sync:${portal.id}`),
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
      ]),
      el('div', { class: 'row' }, actions),
    ]),
    portal.lastError && !syncing
      ? el('div', { class: 'notice', text: `Last sync failed: ${portal.lastError}` })
      : null,
    result && result.withData === 0
      ? el('div', {
          class: 'notice',
          text:
            'Everything came back empty. That usually means the school year has not started, ' +
            'or the sign-in expired and needs doing again.',
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
        await call(() => window.contexto.finishLogin(portal.id), `finish:${portal.id}`);
        await call(() => window.contexto.syncPortal(portal.id), `sync:${portal.id}`);
      },
    }),
  ]);
  app.replaceChildren(done);
}

function addPortalPanel() {
  const name = el('input', { placeholder: 'Veracross', 'aria-label': 'Portal name' });
  const url = el('input', {
    placeholder: 'https://portals.veracross.com/lcc/student',
    'aria-label': 'Portal address',
  });

  return el('div', { class: 'panel' }, [
    el('h2', { text: 'Add a portal' }),
    el('p', {
      class: 'muted small',
      text: 'The address you normally land on after signing in. Copy it from your browser.',
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

async function render() {
  const result = await window.contexto.status();
  if (!result.ok) return app.replaceChildren(el('p', { text: result.error }));
  const { linked, deviceName, portals } = result.value;

  if (!linked) {
    return app.replaceChildren(
      el('div', {}, [
        el('h1', { text: 'ContextoAgent' }),
        el('p', {
          class: 'muted',
          text: 'Reads the school portals that have no API, using the logins you complete yourself.',
        }),
        el('div', { class: 'panel' }, [
          el('h2', { text: 'Link this computer' }),
          el('p', {
            class: 'muted small',
            text:
              'Opens your browser so you can approve it from your account. ' +
              'Nothing is read until you add a portal and sign in.',
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
        ? el('div', { class: 'panel' }, [el('h2', { text: 'Portals' }), ...portals.map(portalRow)])
        : null,
      addPortalPanel(),
    ]),
  );
}

window.contexto.onPortalsChanged(() => void render());
void render();
