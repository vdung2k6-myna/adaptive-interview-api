/**
 * The dimension every stored embedding is queried at.
 *
 * One definition, because the store's SQL cast and the preflight check must
 * agree: if they drift, a model swap passes the check and fails the first
 * position query.
 */
export const EMBED_DIMENSION = 1024; // mxbai-embed-large
