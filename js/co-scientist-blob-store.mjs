/** Netlify Blobs persistence for the co-scientist archive (production daily sync). */

const BLOB_KEY = "archive";

export async function getNetlifyBlobStore() {
  if (!process.env.NETLIFY && !process.env.AWS_LAMBDA_FUNCTION_NAME) return null;
  try {
    const { getStore } = await import("@netlify/blobs");
    return getStore({ name: "co-scientist-archive", consistency: "strong" });
  } catch {
    return null;
  }
}

export async function loadBlobArchive(store) {
  if (!store) return null;
  try {
    return await store.get(BLOB_KEY, { type: "json" });
  } catch {
    return null;
  }
}

export async function saveBlobArchive(store, archive) {
  if (!store) return;
  await store.setJSON(BLOB_KEY, archive);
}
