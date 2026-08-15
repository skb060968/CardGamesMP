import { getApp, getApps, initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  setPersistence,
  signInAnonymously,
} from 'firebase/auth';
import { getDatabase } from 'firebase/database';

const REQUIRED_CONFIG = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'];

export function readFirebaseConfig(env = import.meta.env) {
  const config = {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    databaseURL: env.VITE_FIREBASE_DATABASE_URL,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };
  const missing = REQUIRED_CONFIG.filter((key) => !config[key]);
  if (missing.length) throw new Error(`Missing Firebase configuration: ${missing.join(', ')}`);
  return config;
}

function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function createFirebaseClient({
  config = readFirebaseConfig(),
  appName = 'cardgamesmp-session-v2',
  signal,
} = {}) {
  if (typeof appName !== 'string' || !appName.trim()) throw new TypeError('appName is required');
  const existing = getApps().find((candidate) => candidate.name === appName);
  const app = existing ? getApp(appName) : initializeApp(config, appName);
  const auth = getAuth(app);
  const database = getDatabase(app);
  await withAbort(setPersistence(auth, browserLocalPersistence), signal);
  if (typeof auth.authStateReady === 'function') {
    await withAbort(auth.authStateReady(), signal);
  }
  const user = auth.currentUser || (await withAbort(signInAnonymously(auth), signal)).user;
  if (!user?.uid) throw new Error('Firebase authentication did not return a UID');
  return Object.freeze({ app, auth, database, user, uid: user.uid });
}