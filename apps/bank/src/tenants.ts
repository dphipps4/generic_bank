// The four banks: one product, four configurations. The bank shares no code with the
// automation that drives it.
export interface Tenant {
  id: 'generic' | 'example' | 'sample' | 'placeholder';
  brand: string;
  version: string;
  basePath: string;
}

export const TENANTS: Record<Tenant['id'], Tenant> = {
  generic: { id: 'generic', brand: 'Generic Bank', version: '4.2', basePath: '/corelink/' },
  example: { id: 'example', brand: 'Example Credit Union', version: '4.3', basePath: '/' },
  sample: {
    id: 'sample',
    brand: 'Sample Savings Bank',
    version: '4.3',
    basePath: '/online/branch/',
  },
  placeholder: {
    id: 'placeholder',
    brand: 'Placeholder Federal Credit Union',
    version: '4.4',
    basePath: '/cu/ib/',
  },
};
