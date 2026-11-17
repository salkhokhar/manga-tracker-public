// Web Crypto for supabase-js's PKCE sign-in, backed by expo-crypto.
//
// React Native has no global `crypto`, so supabase-js fell back to building
// the PKCE verifier with Math.random and sending it in "plain" mode, where the
// verifier itself travels in the sign-in URL. With these two functions it uses
// a cryptographically random verifier and only sends its SHA-256 hash.
// Only fills what is missing; never replaces a real implementation.
// Must be imported before the Supabase client is created (services/supabase.ts).

import * as ExpoCrypto from 'expo-crypto';

const g: any = globalThis as any;
if (typeof g.crypto !== 'object' || g.crypto === null) g.crypto = {};
if (typeof g.crypto.getRandomValues !== 'function') {
    g.crypto.getRandomValues = (array: any) => ExpoCrypto.getRandomValues(array);
}
if (typeof g.crypto.subtle !== 'object' || g.crypto.subtle === null) {
    g.crypto.subtle = {
        digest: (algorithm: string | { name: string }, data: BufferSource): Promise<ArrayBuffer> => {
            const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;
            if (name !== 'SHA-256') return Promise.reject(new Error(`crypto.subtle.digest: unsupported algorithm ${name}`));
            return ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, data);
        },
    };
}

export {};
