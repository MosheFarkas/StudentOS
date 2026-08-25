import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ArchiveError, readDocx, readPptx, readZip } from './archive.js';

/** Word stores its text in word/document.xml, one <w:t> per run. */
function docx(paragraphs: string[][]): Uint8Array {
  const body = paragraphs
    .map((runs) => `<w:p>${runs.map((r) => `<w:t>${r}</w:t>`).join('')}</w:p>`)
    .join('');
  return zipSync({
    'word/document.xml': strToU8(`<w:document><w:body>${body}</w:body></w:document>`),
  });
}

function pptx(slides: string[][]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  slides.forEach((runs, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(
      `<p:sld><p:cSld>${runs.map((r) => `<a:p><a:t>${r}</a:t></a:p>`).join('')}</p:cSld></p:sld>`,
    );
  });
  return zipSync(files);
}

describe('readZip', () => {
  it('returns entries with their contents', () => {
    const archive = zipSync({
      'Prelim1/main.py': strToU8('print("hello")'),
      'Prelim1/notes.txt': strToU8('read chapter 4'),
    });

    const entries = readZip(archive);
    expect(entries.map((e) => e.path).sort()).toEqual(['Prelim1/main.py', 'Prelim1/notes.txt']);
  });

  it('skips directory markers and empty entries', () => {
    const archive = zipSync({ 'folder/': strToU8(''), 'folder/a.txt': strToU8('x') });
    expect(readZip(archive).map((e) => e.path)).toEqual(['folder/a.txt']);
  });

  /**
   * A zip bomb is a few kilobytes that expands to gigabytes, and this runs
   * inside a 512MB cgroup shared with the rest of the service. Highly
   * compressible content is exactly the shape of the attack.
   */
  it('refuses an archive that expands past the cap', () => {
    const huge = zipSync({ 'big.txt': strToU8('a'.repeat(45 * 1024 * 1024)) });
    expect(() => readZip(huge)).toThrow(ArchiveError);
  });

  it('rejects something that is not a zip at all', () => {
    expect(() => readZip(strToU8('just some text'))).toThrow(ArchiveError);
  });
});

describe('readDocx', () => {
  it('reads paragraphs as separate lines', () => {
    const text = readDocx(docx([['Chapter 4'], ['Due Friday']]));
    expect(text).toContain('Chapter 4');
    expect(text).toContain('Due Friday');
    expect(text.indexOf('Chapter 4')).toBeLessThan(text.indexOf('Due Friday'));
  });

  /**
   * Word splits a sentence across runs whenever formatting changes mid-word.
   * Stripping tags without a separator turns "Quiet Revolution" into
   * "QuietRevolution", which then fails any search the student asks for.
   */
  it('does not glue together text split across runs', () => {
    expect(readDocx(docx([['Quiet ', 'Revolution']]))).toContain('Quiet Revolution');
  });

  it('decodes escaped characters', () => {
    expect(readDocx(docx([['Bread &amp; butter']]))).toContain('Bread & butter');
  });

  it('explains a Word file with no document inside', () => {
    expect(() => readDocx(zipSync({ 'other.xml': strToU8('<a/>') }))).toThrow(ArchiveError);
  });
});

describe('readPptx', () => {
  it('labels each slide', () => {
    const text = readPptx(pptx([['Title slide'], ['Second slide']]));
    expect(text).toContain('[Slide 1]');
    expect(text).toContain('Title slide');
    expect(text).toContain('[Slide 2]');
  });

  /**
   * Slide files are numbered without padding, so slide10 sorts before slide2
   * under a plain string sort and a deck comes back shuffled -- subtly wrong
   * in a way a student would not spot until an answer cited the wrong slide.
   */
  it('keeps slides in numeric order past nine', () => {
    const deck = pptx(Array.from({ length: 11 }, (_, i) => [`Slide number ${i + 1}`]));
    const text = readPptx(deck);
    expect(text.indexOf('Slide number 2')).toBeLessThan(text.indexOf('Slide number 10'));
  });

  it('explains a deck with no slides', () => {
    expect(() => readPptx(zipSync({ 'ppt/other.xml': strToU8('<a/>') }))).toThrow(ArchiveError);
  });
});

describe('what it will and will not decompress', () => {
  /**
   * The cap used to be checked after unzipSync had already expanded the whole
   * archive into memory, which is the one moment it needed to act. It limited
   * what was kept, not what was allocated -- so a real bomb would have taken
   * the process down before any check ran, inside a 512MB cgroup shared with
   * the rest of the service.
   *
   * fflate can be told, per entry, whether to decompress at all. The declared
   * uncompressed size is in the archive's own index, so the decision costs
   * nothing and happens before the memory does.
   */
  it('skips the geometry and decompresses only what could hold words', async () => {
    /*
     * A real robotics field kit: 93MB compressed, 236MB across 36 files, and
     * a single 144MB .obj model inside it. Not a bomb -- the expansion is
     * 2.5x, where a bomb is a thousand -- but 236MB inside a 512MB cgroup
     * shared with the live service is its own way to fall over.
     *
     * Of those 36 files, six were PDFs and the other thirty were .obj, .fbx,
     * .3mf, .dxf and .step: geometry, which holds coordinates and no words.
     * Decompressing them costs the memory and yields nothing, so the answer
     * is not a bigger ceiling but opening fewer of them.
     */
    const kit = zipSync({
      'field/CRC Mo-Duel.obj': strToU8('v 1.0 2.0 3.0\n'.repeat(200_000)),
      'field/CRC Mo-Duel.step': strToU8('ISO-10303-21;\n'.repeat(100_000)),
      'field/Assembly guide.pdf': strToU8('%PDF-1.4 assembly instructions'),
      'field/notes.txt': strToU8('Tighten the M3 bolts last.'),
    });

    const entries = readZip(kit);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('field/Assembly guide.pdf');
    expect(paths).toContain('field/notes.txt');
    expect(paths).not.toContain('field/CRC Mo-Duel.obj');
    expect(paths).not.toContain('field/CRC Mo-Duel.step');
  });

  it('opens a large archive of many ordinary files', async () => {
    // 400 files of 200KB is 80MB decompressed: bigger than the old ceiling and
    // completely unremarkable. A robotics field kit looked exactly like this.
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 400; i += 1) {
      many[`part-${i}.txt`] = strToU8('x'.repeat(200 * 1024));
    }
    const entries = readZip(zipSync(many));
    expect(entries.length).toBeGreaterThan(300);
  });

  it('refuses a single entry that claims to expand absurdly', () => {
    // The shape of a bomb: one small entry, one enormous expansion.
    const bomb = zipSync({ 'bomb.txt': strToU8('a'.repeat(50 * 1024 * 1024)) });
    expect(() => readZip(bomb)).toThrow(/too large/i);
  });

  it('still reads a Word file, which is a zip underneath', () => {
    const docx = zipSync({ 'word/document.xml': strToU8('<w:t>Hello</w:t>') });
    expect(readDocx(docx)).toContain('Hello');
  });
});
