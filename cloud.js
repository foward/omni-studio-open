// Optional Google Cloud sync layer for OmniStudio.
//
// When configured via env vars, media files (videos/audio/images) mirror to a
// Cloud Storage bucket and metadata (projects + planner) persists to Firestore —
// so two machines pointing at the same GCP project share identical data.
//
// Everything here is OPT-IN and degrades gracefully: with no env config the app
// runs exactly as before (local files + localStorage), and any cloud error is
// logged and swallowed rather than breaking a request.
//
// Enable with:
//   GCP_PROJECT_ID=your-project-id
//   GCS_BUCKET=your-bucket-name
//   GOOGLE_APPLICATION_CREDENTIALS=/abs/path/service-account.json   (or gcloud ADC)
//   FIRESTORE_DATABASE=(default)                                    (optional)

import fs from 'fs';
import path from 'path';

const PROJECT_ID = process.env.GCP_PROJECT_ID || '';
const BUCKET = process.env.GCS_BUCKET || '';
const FIRESTORE_DB = process.env.FIRESTORE_DATABASE || '(default)';

let bucket = null;       // GCS bucket handle
let firestore = null;    // Firestore handle
let ready = false;
let initError = null;

export const cloud = {
  get storageEnabled() { return !!bucket; },
  get firestoreEnabled() { return !!firestore; },
  get enabled() { return !!bucket || !!firestore; },
  get status() {
    return {
      enabled: this.enabled,
      storage: this.storageEnabled ? BUCKET : null,
      firestore: this.firestoreEnabled ? `${PROJECT_ID}/${FIRESTORE_DB}` : null,
      error: initError
    };
  }
};

// Lazily import the SDKs so the app doesn't require them when cloud is disabled
export async function initCloud() {
  if (ready) return cloud;
  ready = true;

  if (BUCKET) {
    try {
      const { Storage } = await import('@google-cloud/storage');
      const storage = new Storage(PROJECT_ID ? { projectId: PROJECT_ID } : {});
      bucket = storage.bucket(BUCKET);
      // Cheap reachability check
      const [exists] = await bucket.exists();
      if (!exists) throw new Error(`bucket "${BUCKET}" not found or no access`);
      console.log(`☁️  Cloud Storage sync ON → gs://${BUCKET}`);
    } catch (err) {
      bucket = null;
      initError = `Storage: ${err.message}`;
      console.warn(`☁️  Cloud Storage disabled: ${err.message}`);
    }
  }

  if (process.env.FIRESTORE_ENABLED !== 'false' && (PROJECT_ID || process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    try {
      const { Firestore } = await import('@google-cloud/firestore');
      firestore = new Firestore(PROJECT_ID ? { projectId: PROJECT_ID, databaseId: FIRESTORE_DB } : { databaseId: FIRESTORE_DB });
      // Cheap reachability check
      await firestore.collection('_omnistudio_meta').doc('ping').set({ at: Date.now() }, { merge: true });
      console.log(`☁️  Firestore sync ON → ${PROJECT_ID || 'ADC project'}/${FIRESTORE_DB}`);
    } catch (err) {
      firestore = null;
      initError = (initError ? initError + '; ' : '') + `Firestore: ${err.message}`;
      console.warn(`☁️  Firestore disabled: ${err.message}`);
    }
  }

  return cloud;
}

/* ----------------------------- Media (GCS) ----------------------------- */

// Upload a local outputs/ file to the bucket under media/<filename>
export async function mirrorMedia(filePath) {
  if (!bucket) return false;
  const filename = path.basename(filePath);
  try {
    await bucket.upload(filePath, {
      destination: `media/${filename}`,
      resumable: false,
      metadata: { cacheControl: 'public, max-age=31536000' }
    });
    return true;
  } catch (err) {
    console.warn(`Cloud upload failed for ${filename}: ${err.message}`);
    return false;
  }
}

// Archive finished deliverables to an organized, human-browsable library path:
//   library/<channel-slug>/<yyyy-mm-dd>_<video-slug>/<name>
// (media/ stays a flat working cache — the lazy pull-through depends on it;
// library/ is the curated per-video folder you actually browse in the console.)
// files: [{ path, name? }] — name overrides the stored filename (e.g. master.mp4)
export async function archiveToLibrary(prefix, files) {
  if (!bucket) return { archived: 0, path: null, error: 'Cloud Storage not configured' };
  let archived = 0;
  for (const f of files) {
    if (!f || !f.path || !fs.existsSync(f.path)) continue;
    const dest = `library/${prefix}/${f.name || path.basename(f.path)}`;
    try {
      await bucket.upload(f.path, { destination: dest, resumable: false });
      archived++;
    } catch (err) {
      console.warn(`Library archive failed for ${dest}: ${err.message}`);
    }
  }
  if (archived) console.log(`☁️  Archived ${archived} file(s) → gs://${BUCKET}/library/${prefix}/`);
  return { archived, path: `gs://${BUCKET}/library/${prefix}/` };
}

// Ensure a file exists locally, pulling it from the bucket if missing.
// Returns true if the file is present locally afterwards.
export async function ensureMedia(filename, localPath) {
  if (fs.existsSync(localPath)) return true;
  if (!bucket) return false;
  try {
    const file = bucket.file(`media/${filename}`);
    const [exists] = await file.exists();
    if (!exists) return false;
    await file.download({ destination: localPath });
    console.log(`☁️  Pulled ${filename} from Cloud Storage`);
    return true;
  } catch (err) {
    console.warn(`Cloud pull failed for ${filename}: ${err.message}`);
    return false;
  }
}

/* --------------------------- Metadata (Firestore) --------------------------- */

// Firestore doc size limit is ~1MB; project state (JSON, media referenced by
// filename) stays well under it. Custom character images are the only risk and
// are already dropped under quota pressure client-side.

export async function saveDoc(collection, docId, data) {
  if (!firestore) return false;
  try {
    await firestore.collection(collection).doc(docId).set({ data, updatedAt: Date.now() });
    return true;
  } catch (err) {
    console.warn(`Firestore save ${collection}/${docId} failed: ${err.message}`);
    return false;
  }
}

export async function loadDoc(collection, docId) {
  if (!firestore) return null;
  try {
    const snap = await firestore.collection(collection).doc(docId).get();
    return snap.exists ? snap.data().data : null;
  } catch (err) {
    console.warn(`Firestore load ${collection}/${docId} failed: ${err.message}`);
    return null;
  }
}
