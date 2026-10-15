// What Chrome on a Mac sends with a top-level page load (plan, Appendix W.2), for tests that
// reach a bank over plain HTTP and must look like a person's browser to banks 2, 3 and 4.

const V = '141';

export const MAC_CHROME_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${V}.0.0.0 Safari/537.36`;

export const MAC_CHROME: Record<string, string> = {
  'sec-ch-ua': `"Google Chrome";v="${V}", "Not?A_Brand";v="8", "Chromium";v="${V}"`,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'upgrade-insecure-requests': '1',
  'user-agent': MAC_CHROME_UA,
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'sec-fetch-site': 'same-origin',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-user': '?1',
  'sec-fetch-dest': 'document',
  'accept-encoding': 'gzip, deflate, br, zstd',
  'accept-language': 'en-US,en;q=0.9',
};
