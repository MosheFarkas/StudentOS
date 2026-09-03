import { useEffect, useRef, useState } from 'react';
import type { Agent } from '@contexto/shared';
import { api } from '../lib/api.js';
import { navigate } from '../lib/router.js';
import type { Route } from '../lib/router.js';
import { signOut } from '../lib/auth.js';
import { initialOf } from '../lib/initial.js';
import { LogoMark } from './LogoMark.js';

interface Props {
  route: Route;
  /** Whether the open chat's agent is mid-turn, so the mark can fold. */
  working: boolean;
  /** The signed-in student, for the footer. Either may be missing. */
  name?: string | null;
  email?: string | null;
}

/**
 * The rail down the left: what you are, what you can start, what you have said.
 *
 * A chat is an agent row underneath -- the two words mean the same thing here
 * for now -- so the list is the same GET the agent list used to make. What has
 * gone is the idea that you build an agent before you can talk to one: New
 * opens a chat, and the agent behind it is plumbing the student never meets.
 */
export function Sidebar({ route, working, name, email }: Props) {
  const [chats, setChats] = useState<Agent[] | null>(null);

  /*
   * Re-read on every change of screen, not just on mount.
   *
   * A chat created from the new-chat screen exists only on the server until
   * something asks again, and the moment it is worth asking is exactly the
   * navigation that follows creating it. Keyed on the route rather than a
   * timer: one GET when the student moves, none while they read.
   */
  const at = route.name === 'chat' ? route.agentId : route.name;

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.agents.$get();
        if (!res.ok) return;
        setChats((await res.json()).agents);
      } catch {
        // A sidebar that cannot list is still a sidebar you can start from.
        // Failing here must not take the composer down with it.
      }
    })();
  }, [at]);

  return (
    <aside className="sidebar">
      <button
        className="sidebar-brand"
        aria-label="ContextoAgent"
        onClick={() => go({ name: 'new' })}
      >
        <LogoMark size={30} working={working} />
        <img className="sidebar-wordmark" src="/wordmark.png" alt="ContextoAgent" />
      </button>

      <button
        className={`sidebar-new${route.name === 'new' ? ' is-current' : ''}`}
        onClick={() => go({ name: 'new' })}
      >
        <PlusIcon />
        <span>New</span>
      </button>

      <nav className="sidebar-chats" aria-label="Chats">
        {chats?.map((chat) => (
          <button
            key={chat.id}
            className={`sidebar-chat${
              route.name === 'chat' && route.agentId === chat.id ? ' is-current' : ''
            }`}
            title={chat.name}
            onClick={() => go({ name: 'chat', agentId: chat.id })}
          >
            {chat.name}
          </button>
        ))}
      </nav>

      <Account name={name} email={email} />
    </aside>
  );
}

/**
 * Navigation that also closes the drawer on a phone.
 *
 * The sidebar is a drawer under 900px, and a tap that changes the screen
 * behind an open drawer without closing it leaves the student looking at the
 * same list they just chose from.
 */
function go(route: Route): void {
  document.body.classList.remove('nav-open');
  navigate(route);
}

/**
 * The footer: who is signed in, and the way to the screens the header used to
 * hold.
 *
 * Settings and Sign out lost their home when the header went, and neither is
 * worth a row in the rail -- so they live behind the name, which is where a
 * student already looks for their own account.
 */
function Account({ name, email }: { name?: string | null; email?: string | null }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  /** A menu that ignores a click elsewhere is a menu you cannot put away. */
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const label = name?.trim() || email?.split('@')[0] || 'Account';

  return (
    <div className="sidebar-account" ref={box}>
      {open && (
        <div className="account-menu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              go({ name: 'settings' });
            }}
          >
            Settings
          </button>
          <button role="menuitem" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      )}

      <button
        className="account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="account-initial" aria-hidden="true">
          {initialOf(label)}
        </span>
        <span className="account-name">{label}</span>
      </button>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M8 3.25v9.5M3.25 8h9.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
