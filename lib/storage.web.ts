import type { KeyValueStorage } from './chunkedStorage';

// Web storage. Must not import expo-secure-store (keeps it out of the web bundle).
// Guarded so nothing breaks if this module is ever evaluated without a window.
const hasWindow = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

export const storage: KeyValueStorage = {
  async getItem(key) {
    return hasWindow() ? window.localStorage.getItem(key) : null;
  },
  async setItem(key, value) {
    if (hasWindow()) window.localStorage.setItem(key, value);
  },
  async removeItem(key) {
    if (hasWindow()) window.localStorage.removeItem(key);
  },
};
