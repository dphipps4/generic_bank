import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '@gb/screen';
import { maskScreenshot, maskText } from '../src/mask.js';

const policy = { known: ['Alex', 'Sample', '1234567890', 'service-password-for-tests'] };

describe('masking text', () => {
  it('masks known values wherever they appear, whatever the case', () => {
    expect(maskText('Member 40017732 · A. Sample', policy)).toBe('Member ******** · A. ******');
    expect(maskText('alex typed service-password-for-tests', policy)).toBe(
      '**** typed **************************',
    );
  });

  it('masks the patterns: money, digit runs, emails, phones, street lines', () => {
    expect(maskText('Available balance: $4,812.55', policy)).toBe('Available balance: *********');
    expect(maskText('Account ending in 7890', policy)).toBe('Account ending in ****');
    expect(maskText('Email to op0412@generic.bank.localhost', policy)).toBe(
      `Email to ${'*'.repeat('op0412@generic.bank.localhost'.length)}`,
    );
    expect(maskText('Text message to +1 555 010412', policy)).toContain('***');
    expect(maskText('Lives at 12 Elm Street, Springfield', policy)).toBe(
      'Lives at ** *** ******, Springfield',
    );
  });

  it('leaves what is not sensitive alone: short numbers, words, versions', () => {
    expect(maskText('CoreLink Branch Console 4.2', policy)).toBe('CoreLink Branch Console 4.2');
    expect(maskText('Statements for 12 months', policy)).toBe('Statements for 12 months');
  });
});

describe('masking a screenshot', () => {
  it('covers each box white, with asterisks and an outline, and leaves the rest untouched', () => {
    const w = 60;
    const h = 30;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([20, 40, 200, 255], i * 4);
    const out = decodePng(
      maskScreenshot(encodePng({ width: w, height: h, data }), [{ x: 10, y: 5, w: 30, h: 16 }]),
    );
    const px = (x: number, y: number) => [
      ...out.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 3),
    ];
    expect(px(0, 0)).toEqual([20, 40, 200]);
    const inside: number[][] = [];
    for (let y = 6; y < 21; y++) for (let x = 11; x < 40; x++) inside.push(px(x, y));
    expect(inside.every(([r, g, b]) => r === g && g === b)).toBe(true);
    expect(inside.some(([r]) => r === 120)).toBe(true);
    expect(inside.filter(([r]) => r === 255).length).toBeGreaterThan(inside.length / 2);
  });
});
