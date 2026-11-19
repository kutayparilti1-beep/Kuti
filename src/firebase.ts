import { initializeApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  linkWithPopup,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  User,
} from 'firebase/auth';
import {
  doc,
  getDoc,
  getDocFromServer,
  getFirestore,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

export const ADMIN_EMAIL = 'kutayparilti1@gmail.com';

export const WORKSPACE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
];

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

const googleProvider = new GoogleAuthProvider();
WORKSPACE_SCOPES.forEach((scope) => googleProvider.addScope(scope));
googleProvider.setCustomParameters({ prompt: 'select_account' });

// In-memory access token storage ONLY (never localStorage or sessionStorage)
let cachedWorkspaceAccessToken: string | null = null;
let isSigningIn = false;

export const getWorkspaceAccessToken = (): string | null => cachedWorkspaceAccessToken;

export const setWorkspaceAccessToken = (token: string | null) => {
  cachedWorkspaceAccessToken = token;
};

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration (client is offline).');
    }
  }
}
void testConnection();

export function isAdminUser(user: User | null): boolean {
  if (!user || !user.email) return false;
  return user.email.toLowerCase() === ADMIN_EMAIL && user.emailVerified === true;
}

const inFlightRegistrySyncs = new Map<string, Promise<void>>();

export async function syncUserRegistry(user: User): Promise<void> {
  if (!user.email || !user.emailVerified) return;
  const existingPromise = inFlightRegistrySyncs.get(user.uid);
  if (existingPromise) return existingPromise;

  const task = (async () => {
    const ref = doc(db, 'user_registry', user.uid);
    try {
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          uid: user.uid,
          email: user.email,
          createdAt: serverTimestamp(),
          lastSeenAt: serverTimestamp(),
        });
      } else {
        await updateDoc(ref, {
          lastSeenAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `user_registry/${user.uid}`);
    } finally {
      inFlightRegistrySyncs.delete(user.uid);
    }
  })();

  inFlightRegistrySyncs.set(user.uid, task);
  return task;
}

export const subscribeToAuth = (
  onChange: (user: User | null, workspaceToken: string | null) => void
) => {
  return onAuthStateChanged(auth, (user) => {
    if (!user) {
      cachedWorkspaceAccessToken = null;
      onChange(null, null);
      return;
    }
    if (!isSigningIn) {
      onChange(user, cachedWorkspaceAccessToken);
    }
  });
};

export async function signInWithGoogleWorkspace(): Promise<{
  user: User;
  accessToken: string | null;
}> {
  isSigningIn = true;
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const token = credential?.accessToken ?? null;
    cachedWorkspaceAccessToken = token;
    if (result.user.emailVerified) {
      await syncUserRegistry(result.user);
    }
    return { user: result.user, accessToken: token };
  } finally {
    isSigningIn = false;
  }
}

export async function connectWorkspaceWithGoogle(): Promise<string | null> {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error('Önce oturum açmalısınız.');
  isSigningIn = true;
  try {
    let result;
    const hasGoogleProvider = currentUser.providerData.some(
      (p) => p.providerId === 'google.com'
    );
    if (!hasGoogleProvider) {
      try {
        result = await linkWithPopup(currentUser, googleProvider);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'auth/credential-already-in-use' || code === 'auth/email-already-in-use') {
          result = await signInWithPopup(auth, googleProvider);
        } else {
          throw err;
        }
      }
    } else {
      result = await signInWithPopup(auth, googleProvider);
    }
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const token = credential?.accessToken ?? null;
    cachedWorkspaceAccessToken = token;
    return token;
  } finally {
    isSigningIn = false;
  }
}

export async function signInWithEmail(email: string, password: string): Promise<User> {
  isSigningIn = true;
  try {
    const result = await signInWithEmailAndPassword(auth, email.trim(), password);
    if (result.user.emailVerified) {
      await syncUserRegistry(result.user);
    }
    return result.user;
  } finally {
    isSigningIn = false;
  }
}

export async function registerWithEmail(email: string, password: string): Promise<User> {
  isSigningIn = true;
  try {
    const result = await createUserWithEmailAndPassword(auth, email.trim(), password);
    await sendEmailVerification(result.user);
    return result.user;
  } finally {
    isSigningIn = false;
  }
}

export async function resendVerificationEmail(): Promise<void> {
  if (!auth.currentUser) return;
  await sendEmailVerification(auth.currentUser);
}

export async function resetPasswordEmail(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email.trim());
}

export async function reloadCurrentUser(): Promise<User | null> {
  if (!auth.currentUser) return null;
  await auth.currentUser.reload();
  if (auth.currentUser.emailVerified) {
    await syncUserRegistry(auth.currentUser);
  }
  return auth.currentUser;
}

export async function logoutUser(): Promise<void> {
  cachedWorkspaceAccessToken = null;
  await signOut(auth);
}
