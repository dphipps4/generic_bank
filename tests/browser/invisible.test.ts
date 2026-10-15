import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, readScreen } from '../../packages/screen/src/index.js';
import { maskModel } from '../../packages/evidence/src/index.js';

// Evidence holds only what is on screen: no node that is invisible, however it was hidden.

let browser: Browser;
beforeAll(async () => {
  browser = await Browser.launch();
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const PAGE = `<!doctype html><html><body>
<p>Shown text</p><button>Shown button</button>
<div style="opacity:0"><p>Faded text</p><button>Faded button</button></div>
<div style="visibility:hidden"><p>Hidden text</p><button>Hidden button</button></div>
<div style="display:none"><p>Undisplayed text</p><button>Undisplayed button</button></div>
<div style="position:absolute;left:-5000px"><p>Offscreen text</p><button>Offscreen button</button></div>
<div id="host"></div>
<select><option>First choice</option><option>Second choice</option></select>
<script>
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<p>Shadow text</p><button>Shadow button</button>';
</script>
</body></html>`;

describe('the screen model keeps no invisible node', () => {
  it('leaves out transparent, hidden, undisplayed, offscreen and shadow-DOM nodes, and closed list options', async () => {
    const page = await browser.newPage();
    await page.goto(`data:text/html,${encodeURIComponent(PAGE)}`);
    await new Promise((r) => setTimeout(r, 500));
    const m = await readScreen(page);
    const words = [...m.texts.map((t) => t.text), ...m.controls.map((c) => c.name)].join(' | ');
    expect(words).toContain('Shown text');
    expect(words).toContain('Shown button');
    for (const gone of ['Faded', 'Hidden', 'Undisplayed', 'Offscreen', 'Shadow'])
      expect(words).not.toContain(gone);

    const stored = JSON.stringify(maskModel(m, { known: [] }));
    expect(stored).toContain('First choice');
    expect(stored).not.toContain('Second choice');
    await page.close();
  }, 60_000);
});
