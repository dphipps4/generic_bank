# The runtime

What every crawler uses to drive a bank's console: see the page first, then click what's drawn. We have a bank's web UI and nothing else, so it drives Chrome through Playwright, the standard library, and presents as Chrome on a Mac.

| File | What it does |
|---|---|
| `browser.ts` | Chrome without the automation switches; Chrome on a Mac, set from outside the page; dialogs answered and recorded |
| `see.ts` | Waits until the page is ready (the picture holds still, nothing says loading, something to act on), then keeps the masked picture, the rendered page and the address; knows a page by its visible words |
| `act.ts` | Finds a field by its drawn label and a control by its drawn name; presses only what's visible, stable and uncovered |
| `mask.ts` | Masks money, long numbers and known values in the picture (from the browser's own layout), the page text and the address |
| `picture.ts` | Fingerprints a picture of text, so it can be named once and known again |

**The browser:** for development, `just browser` installs Chrome for Testing into `.run/browser`; set `CHROME_PATH` to use another. The Runner's image uses Debian's Chromium. Nothing else is downloaded.

**Tests:** `npx vitest run packages/runtime` runs one synthetic page for each trouble the banks show. They need a Chrome, so CI runs them in its browser job.
