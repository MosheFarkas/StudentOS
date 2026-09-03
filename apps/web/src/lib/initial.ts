/**
 * The letter in the avatar circle.
 *
 * Uppercased from the first character rather than the first letter of each
 * word: one letter is the whole design, and a student called "lucas" should
 * still get an L. Spread rather than indexed, so an accented pair or an emoji
 * is not sliced in half.
 */
export function initialOf(label: string): string {
  return [...label.trim()][0]?.toUpperCase() ?? '?';
}
