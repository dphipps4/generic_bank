# The runtime

What every crawler uses to drive a bank's console: see the page first, then click what's drawn. We have a bank's web UI and nothing else, so it drives Chrome through Playwright, the standard library, and presents as Chrome on a Mac.

| File | What it does |
|---|---|
| `browser.ts` | Chrome without the automation switches; Chrome on a Mac, set from outside the page; dialogs answered and recorded |
| `see.ts` | Waits until the page is ready (the picture holds still twice running, nothing says loading, something to act on), then keeps the masked picture, the rendered page and the address; knows a screen by its visible words and its pictures |
| `act.ts` | Finds a field by its drawn label and a control by its drawn name; presses only what's visible, stable and uncovered |
| `hands.ts` | Acts at a point as a person's hands do: the real mouse and keyboard, and the browser itself says what is at that point |
| `match.ts` | Finds a cut-out (a label drawn as text or as a picture) on a fresh screenshot; a weak or unclear match is no match |
| `rule.ts` | The one masking rule every view follows |
| `mask.ts` | Applies it: to the picture (from the browser's own layout), the page text and the address |

**The browser:** for development, `just browser` installs Chrome for Testing into `.run/browser`; set `CHROME_PATH` to use another. The Runner's image uses Debian's Chromium. Nothing else is downloaded.

**Tests:** `npx vitest run packages/runtime` runs one synthetic page for each trouble the banks show. They need a Chrome, so they run in the full suite on master.
