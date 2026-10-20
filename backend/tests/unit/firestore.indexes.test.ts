import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Firestore emulator accepts queries and index definitions that production
 * rejects, so these production rules are checked statically. A violation fails
 * `firebase deploy` (index) or throws at runtime (query).
 */
const root = new URL('../../', import.meta.url).pathname;
const indexes = JSON.parse(readFileSync(join(root, '../firestore.indexes.json'), 'utf8')) as {
  indexes: { collectionGroup: string; fields: { fieldPath: string; arrayConfig?: string; order?: string }[] }[];
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('Firestore production constraints', () => {
  it('composite indexes use at most one array-contains field and at least two fields', () => {
    for (const ix of indexes.indexes) {
      const label = `${ix.collectionGroup}: ${ix.fields.map((f) => f.fieldPath).join(', ')}`;
      expect(ix.fields.filter((f) => f.arrayConfig).length, label).toBeLessThanOrEqual(1);
      expect(ix.fields.length, label).toBeGreaterThanOrEqual(2);
    }
  });

  it('no query chains two array-contains filters', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(root, 'src'))) {
      // One query chain = text from a collection reference to the next one or the end of the statement.
      for (const statement of readFileSync(file, 'utf8').split(';')) {
        for (const chain of statement.split(/this\.p\.|\.collection(?:Group)?\(/)) {
          if ((chain.match(/'array-contains(-any)?'/g) ?? []).length > 1) offenders.push(`${file.slice(root.length)}: ${chain.trim().slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
