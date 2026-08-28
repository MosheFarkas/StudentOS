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
}
