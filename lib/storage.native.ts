import * as SecureStore from 'expo-secure-store';

import { createChunkedStorage, type KeyValueStorage } from './chunkedStorage';

// SecureStore values are size-limited (~2 KB is the documented safe size on iOS),
// and a Supabase session JSON can be larger, so values are chunked.
const CHUNK_SIZE = 1800;

const secureStoreBacking: KeyValueStorage = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  removeItem: (key) => SecureStore.deleteItemAsync(key),
};

export const storage: KeyValueStorage = createChunkedStorage(secureStoreBacking, { chunkSize: CHUNK_SIZE });
