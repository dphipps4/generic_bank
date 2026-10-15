import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The image installs dependencies from each workspace's package.json, copied one by one so the
// install is cached. A workspace missing from that list installs without its links, and the image
// fails to build (or worse, builds without it). Every workspace must be listed.
const root = join(import.meta.dirname, '../../..');

describe('the Node image', () => {
  it('copies every workspace’s package.json before installing', () => {
    const dockerfile = readFileSync(join(root, 'infra/docker/node.Dockerfile'), 'utf8');
    for (const group of ['apps', 'packages']) {
      for (const name of readdirSync(join(root, group))) {
        if (!existsSync(join(root, group, name, 'package.json'))) continue;
        expect(dockerfile, `${group}/${name}`).toContain(
          `COPY ${group}/${name}/package.json ${group}/${name}/`,
        );
      }
    }
  });
});
