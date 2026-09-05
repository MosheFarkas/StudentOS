import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetGraph, loadGraph } from './vaultGraph.js';

// The API is the boundary: what matters is how many times it is asked.
const get = vi.hoisted(() => vi.fn());
vi.mock('./api.js', () => ({ api: { vault: { graph: { $get: get } } } }));

const graph = { nodes: [], edges: [] };
const ok = () => Promise.resolve({ ok: true, json: () => Promise.resolve(graph) });
const failed = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });

describe('loadGraph', () => {
  beforeEach(() => {
    get.mockReset();
    forgetGraph();
  });

  it('asks once, however many are waiting', async () => {
    get.mockImplementation(ok);
    const [a, b] = await Promise.all([loadGraph(), loadGraph()]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('asks again once forgotten', async () => {
    get.mockImplementation(ok);
    await loadGraph();
    forgetGraph();
    await loadGraph();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('is nothing when the request fails, and tries again next time', async () => {
    get.mockImplementationOnce(failed).mockImplementation(ok);
    expect(await loadGraph()).toBeNull();
    expect(await loadGraph()).toEqual(graph);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
