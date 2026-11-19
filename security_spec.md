# Security Specification — Vega Asistan

## 1. Data Invariants
1. **Strict Authentication Gate**: No unauthenticated reads or writes are permitted anywhere in Firestore.
2. **Verified Identity**: All writes and admin reads require `request.auth.token.email_verified == true`.
3. **Owner Isolation**: Subcollections under `/users/{userId}/...` (`known_faces`, `memories`, `tasks`, `notifications`) are readable, writable, and deletable exclusively by the authenticated owner whose `request.auth.uid == userId` and `data.ownerId == request.auth.uid`.
4. **Admin Email Isolation**: `/user_registry/{userId}` can be listed only by the verified admin (`request.auth.token.email == 'kutayparilti1@gmail.com' && request.auth.token.email_verified == true`). Regular users can only read/write their own `/user_registry/{request.auth.uid}` entry and cannot list other users.
5. **No Binary Media Blobs**: Firestore documents store only text descriptors and bounded arrays (e.g., `facialTraits.size() <= 12`), never raw images or audio.
6. **Temporal & Key Integrity**: Every document enforces exact `keys().hasAll(...) && keys().hasOnly(...)` on create, `affectedKeys().hasOnly(...)` per action on update, immutable `ownerId`/`uid`/`createdAt`, and server-enforced `request.time` timestamps.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Read on `/user_registry`** -> Expected: `PERMISSION_DENIED`.
2. **Non-admin `list` on `/user_registry`** -> Expected: `PERMISSION_DENIED`.
3. **Spoofed Admin Email (`email == 'kutayparilti1@gmail.com'`, `email_verified == false`)** -> Expected: `PERMISSION_DENIED`.
4. **Cross-user `get` on `/users/{otherUid}/known_faces/{faceId}`** -> Expected: `PERMISSION_DENIED`.
5. **Identity Spoofing on create (`/users/{myUid}/memories/{id}` with `ownerId: otherUid`)** -> Expected: `PERMISSION_DENIED`.
6. **Shadow Ghost Field (`isAdmin: true`) on `/user_registry/{myUid}` create** -> Expected: `PERMISSION_DENIED`.
7. **Shadow Ghost Field on `known_faces` update** -> Expected: `PERMISSION_DENIED`.
8. **ID Poisoning (`faceId` > 128 chars or containing `..` / `$`)** -> Expected: `PERMISSION_DENIED`.
9. **Resource Exhaustion (`visualSignature` > 1500 chars or `facialTraits.size() > 12`)** -> Expected: `PERMISSION_DENIED`.
10. **Client-forged `createdAt` timestamp (`createdAt != request.time`)** -> Expected: `PERMISSION_DENIED`.
11. **Mutating immutable `ownerId` or `createdAt` during update** -> Expected: `PERMISSION_DENIED`.
12. **Terminal State Violation (re-opening or mutating `title` on `completed` task if locked, or invalid status enum)** -> Expected: `PERMISSION_DENIED`.
