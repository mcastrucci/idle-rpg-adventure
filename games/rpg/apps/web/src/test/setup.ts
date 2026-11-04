import { beforeEach } from 'vitest';

import { setLocale } from '../i18n/locale.ts';

// Tests assert English copy unless they opt into Spanish with `setLocale('es', { persist: false })`.
beforeEach(() => { setLocale('en', { persist: false }); });
