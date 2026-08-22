import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESPONDING, loadPromptDocument } from './documents.js';

/**
 * The loader's whole job is to fail loudly.
 *
 * A prompt document that goes missing or loses its frontmatter does not break
 * anything a type checker or a health check would notice -- the agent boots,
 * answers, and is simply no longer the thing that was designed. So every one
 * of these cases has to throw at load rather than degrade at runtime.
 */
describe('loading a prompt document', () => {
  let dir: string;

  beforeAll(() => {
    dir = `${mkdtempSync(join(tmpdir(), 'contexto-prompts-'))}/`;
    writeFileSync(
      `${dir}wrong-name.md`,
      '---\nname: something-else\ndescription: x\n---\n\nBody.\n',
    );
    writeFileSync(`${dir}no-description.md`, '---\nname: no-description\n---\n\nBody.\n');
    writeFileSync(`${dir}no-body.md`, '---\nname: no-body\ndescription: x\n---\n\n   \n');
    writeFileSync(`${dir}no-frontmatter.md`, '# Just a heading\n\nBody.\n');
    writeFileSync(
      `${dir}good.md`,
      '---\nname: good\ndescription: A description: with a colon in it.\n---\n\n# Heading\n\nBody.\n',
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('names the missing file rather than surfacing an ENOENT', () => {
    expect(() => loadPromptDocument('nonexistent', dir)).toThrow(/nonexistent\.md is missing/);
  });

  it('rejects a document whose declared name has drifted from its filename', () => {
    // One of the two is a lie and the loader is the last place that can tell.
    expect(() => loadPromptDocument('wrong-name', dir)).toThrow(/not its filename/);
  });

  it('rejects a document with no description', () => {
    expect(() => loadPromptDocument('no-description', dir)).toThrow(/no description/);
  });

  it('rejects frontmatter with nothing under it', () => {
    expect(() => loadPromptDocument('no-body', dir)).toThrow(/no body/);
  });

  it('rejects a document with no frontmatter at all', () => {
    expect(() => loadPromptDocument('no-frontmatter', dir)).toThrow(/frontmatter/);
  });

  it('keeps everything after the first colon in a field', () => {
    // Descriptions are prose and prose contains colons.
    expect(loadPromptDocument('good', dir).description).toBe('A description: with a colon in it.');
  });

  it('returns the body without the frontmatter', () => {
    const body = loadPromptDocument('good', dir).body;
    expect(body.startsWith('# Heading')).toBe(true);
    expect(body).not.toContain('---');
    expect(body).not.toContain('description:');
  });
});

describe('the documents that ship', () => {
  it('loads responding.md at import time', () => {
    expect(RESPONDING.name).toBe('responding');
    expect(RESPONDING.description).not.toBe('');
    expect(RESPONDING.body.length).toBeGreaterThan(500);
  });

  it('does not leak the frontmatter into what the model reads', () => {
    // The description is written for whoever edits the file. Sending it costs
    // tokens on every turn and tells the model nothing it needs.
    expect(RESPONDING.body).not.toContain(RESPONDING.description);
  });
});
