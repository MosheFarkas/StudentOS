/**
 * The one force this app reaches for that the package does not describe.
 *
 * d3-force-3d ships no type declarations and has no @types package. Declaring
 * the whole module would be inventing a surface nobody is using; declaring the
 * single export we call keeps the lie small and the compiler honest about it.
 */
declare module 'd3-force-3d' {
  interface CollideForce {
    (alpha: number): void;
    radius(r: (node: never) => number): CollideForce;
    strength(s: number): CollideForce;
    iterations(n: number): CollideForce;
  }

  export function forceCollide(radius?: (node: never) => number): CollideForce;

  /** The rest of what the physics test builds, to run the scene's own forces. */
  interface Force {
    (alpha: number): void;
    strength(s: number | ((d: never) => number)): Force;
    distance(d: number | ((link: never) => number)): Force;
    id(fn: (node: never) => string): Force;
  }

  export function forceLink(links?: unknown[]): Force;
  export function forceManyBody(): Force;
  /** Radius zero, which makes it a pull towards the middle rather than a shell. */
  export function forceRadial(radius: number): Force;

  interface Simulation {
    force(name: string, force: unknown): Simulation;
    tick(n?: number): Simulation;
    stop(): Simulation;
  }

  export function forceSimulation(nodes?: unknown[], dimensions?: number): Simulation;
}
