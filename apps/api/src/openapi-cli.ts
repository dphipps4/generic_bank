// make api-docs: the OpenAPI document, written from the contracts.
import { openapi } from './catalog.js';

process.stdout.write(`${JSON.stringify(openapi(), null, 2)}\n`);
