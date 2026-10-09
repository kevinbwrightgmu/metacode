import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export function fixtureHtml(name: string): string {
  return readFileSync(join(here, 'fixtures', name), 'utf8');
}

/** A fixture parsed into a Document (scripts are not run). */
export function fixture(name: string): Document {
  return new DOMParser().parseFromString(fixtureHtml(name), 'text/html');
}

export function html(markup: string): Document {
  return new DOMParser().parseFromString(markup, 'text/html');
}
