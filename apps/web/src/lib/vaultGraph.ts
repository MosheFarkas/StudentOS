import { api } from './api.js';
import type { DocEdge, DocNode } from './vaultmap.js';

export interface Graph {
  nodes: DocNode[];
  edges: DocEdge[];
}

/**
 * The vault's shape, asked for once and shared by whoever is waiting.
 *
 * Settings starts the request the moment it opens, so that by the time the
 * memory section is looked at the answer is usually already here, and looking
 * at it twice does not ask twice. Forgotten when settings closes: the vault
 * changes as the agent works, and the next visit should see it as it is.
 */
let pending: Promise<Graph | null> | null = null;

export function loadGraph(): Promise<Graph | null> {
  if (!pending) {
    const mine = fetchGraph().then((graph) => {
      // A failure is not worth keeping: the next asker should try again.
      if (!graph && pending === mine) pending = null;
      return graph;
    });
    pending = mine;
  }
  return pending;
}

export function forgetGraph(): void {
  pending = null;
}

async function fetchGraph(): Promise<Graph | null> {
  try {
    const res = await api.vault.graph.$get();
    if (!res.ok) return null;
    return (await res.json()) as Graph;
  } catch {
    return null;
  }
}
