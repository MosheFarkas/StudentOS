import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extractOfficeText, officeKindFor } from './office.js';

/**
 * Word, PowerPoint, Excel and their open-format cousins.
 *
 * All of them are zip archives with XML inside, which is why one module reads
 * the lot: the difference between a .docx and a .pptx is which entry holds the
 * words and which tag they sit in, not the format of the container.
 *
 * The fixtures are built here rather than committed as binaries. A checked-in
 * .docx is a file nobody can review in a diff, and the parts that matter --
 * the entry names and the tag names -- are exactly what a hand-built archive
 * makes explicit.
 */

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const docx = (body: string) =>
  zip({ 'word/document.xml': body, '[Content_Types].xml': '<Types/>' });

describe('recognising an office file', () => {
  it('knows each format by its extension', () => {
    expect(officeKindFor('essay.docx', '')).toBe('docx');
    expect(officeKindFor('deck.pptx', '')).toBe('pptx');
    expect(officeKindFor('marks.xlsx', '')).toBe('xlsx');
    expect(officeKindFor('notes.odt', '')).toBe('odf');
    expect(officeKindFor('slides.odp', '')).toBe('odf');
  });

  it('is not fooled by case, which a filename never guarantees', () => {
    expect(officeKindFor('ESSAY.DOCX', '')).toBe('docx');
  });

  it('knows them by mime type when the name says nothing', () => {
    const word = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(officeKindFor('download', word)).toBe('docx');
  });

  it('says nothing about files that are not office documents', () => {
    expect(officeKindFor('notes.txt', 'text/plain')).toBeNull();
    expect(officeKindFor('photo.jpg', 'image/jpeg')).toBeNull();
  });
});

describe('reading a Word document', () => {
  it('pulls the words out of the runs', () => {
    const bytes = docx(
      '<w:document><w:body>' +
        '<w:p><w:r><w:t>Unit 1 is due</w:t></w:r><w:r><w:t> on Friday.</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    );
    expect(extractOfficeText(bytes, 'docx')).toBe('Unit 1 is due on Friday.');
  });

  it('keeps paragraphs apart', () => {
    // Runs inside a paragraph join up; paragraphs do not. Without this the
    // whole essay arrives as one line.
    const bytes = docx(
      '<w:body><w:p><w:r><w:t>First.</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Second.</w:t></w:r></w:p></w:body>',
    );
    expect(extractOfficeText(bytes, 'docx')).toBe('First.\nSecond.');
  });

  it('keeps a space that Word marked as significant', () => {
    const bytes = docx(
      '<w:body><w:p><w:r><w:t xml:space="preserve">Due </w:t></w:r>' +
        '<w:r><w:t>Friday</w:t></w:r></w:p></w:body>',
    );
    expect(extractOfficeText(bytes, 'docx')).toBe('Due Friday');
  });

  it('unescapes the entities XML requires', () => {
    const bytes = docx(
      '<w:body><w:p><w:r><w:t>Maths &amp; Physics &lt;3</w:t></w:r></w:p></w:body>',
    );
    expect(extractOfficeText(bytes, 'docx')).toBe('Maths & Physics <3');
  });

  it('drops the paragraphs that hold no words', () => {
    const bytes = docx(
      '<w:body><w:p><w:r><w:t>Real.</w:t></w:r></w:p><w:p/><w:p><w:r/></w:p></w:body>',
    );
    expect(extractOfficeText(bytes, 'docx')).toBe('Real.');
  });
});

describe('reading a slide deck', () => {
  it('reads every slide, in order', () => {
    const bytes = zip({
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Photosynthesis</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Light reactions</a:t></a:r></a:p></p:sld>',
    });
    expect(extractOfficeText(bytes, 'pptx')).toBe('Photosynthesis\nLight reactions');
  });

  it('orders slides by number, not by how the zip stored them', () => {
    // 10 sorts before 2 as a string, which would shuffle a long deck.
    const bytes = zip({
      'ppt/slides/slide10.xml': '<a:p><a:r><a:t>Tenth</a:t></a:r></a:p>',
      'ppt/slides/slide2.xml': '<a:p><a:r><a:t>Second</a:t></a:r></a:p>',
      'ppt/slides/slide1.xml': '<a:p><a:r><a:t>First</a:t></a:r></a:p>',
    });
    expect(extractOfficeText(bytes, 'pptx')).toBe('First\nSecond\nTenth');
  });

  it('ignores the layouts and masters, which are furniture', () => {
    const bytes = zip({
      'ppt/slides/slide1.xml': '<a:p><a:r><a:t>Real slide</a:t></a:r></a:p>',
      'ppt/slideLayouts/slideLayout1.xml': '<a:p><a:r><a:t>Click to edit</a:t></a:r></a:p>',
      'ppt/slideMasters/slideMaster1.xml': '<a:p><a:r><a:t>Master title</a:t></a:r></a:p>',
    });
    expect(extractOfficeText(bytes, 'pptx')).toBe('Real slide');
  });
});

describe('reading a spreadsheet', () => {
  it('reads the shared strings, which is where the words live', () => {
    const bytes = zip({
      'xl/sharedStrings.xml': '<sst><si><t>Biology</t></si><si><t>Chemistry</t></si></sst>',
    });
    expect(extractOfficeText(bytes, 'xlsx')).toBe('Biology\nChemistry');
  });

  it('joins the runs inside one cell', () => {
    const bytes = zip({
      'xl/sharedStrings.xml': '<sst><si><r><t>Due </t></r><r><t>Friday</t></r></si></sst>',
    });
    expect(extractOfficeText(bytes, 'xlsx')).toBe('Due Friday');
  });
});

describe('reading an open-format document', () => {
  it('reads the paragraphs out of content.xml', () => {
    const bytes = zip({
      'content.xml':
        '<office:document-content><office:body><text:p>First line.</text:p>' +
        '<text:p>Second line.</text:p></office:body></office:document-content>',
    });
    expect(extractOfficeText(bytes, 'odf')).toBe('First line.\nSecond line.');
  });

  it('joins the spans inside a paragraph', () => {
    const bytes = zip({
      'content.xml': '<text:p><text:span>Due </text:span><text:span>Friday</text:span></text:p>',
    });
    expect(extractOfficeText(bytes, 'odf')).toBe('Due Friday');
  });
});

describe('when there is nothing to read', () => {
  it('says so rather than throwing, for something that is not a zip at all', () => {
    expect(extractOfficeText(new TextEncoder().encode('just text'), 'docx')).toBeNull();
  });

  it('says so for a zip with no document in it', () => {
    expect(extractOfficeText(zip({ 'random.txt': 'hello' }), 'docx')).toBeNull();
  });

  it('says so for a document that holds no words', () => {
    // An empty deck is not a failure to read; there is simply nothing there.
    expect(extractOfficeText(docx('<w:body><w:p/></w:body>'), 'docx')).toBeNull();
  });

  it('does not mistake a password-protected file for an empty one', () => {
    // Encrypted OOXML is a zip whose parts are not the ones we look for.
    expect(extractOfficeText(zip({ EncryptedPackage: 'nonsense' }), 'docx')).toBeNull();
  });
});
