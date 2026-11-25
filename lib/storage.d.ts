// Type-only entry for `./storage`. Metro and Jest resolve `storage.native.ts` or
// `storage.web.ts` by platform; TypeScript resolves this declaration. Both
// implementations are annotated with `KeyValueStorage`, so they stay in sync.
import type { KeyValueStorage } from './chunkedStorage';

export declare const storage: KeyValueStorage;
