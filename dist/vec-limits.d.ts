/**
 * Limits of the sqlite-vec vec0 KNN that callers must stay inside.
 *
 * Kept apart from db.ts so a module that only pages a KNN does not have to
 * import the schema code.
 */
/**
 * Largest k (the LIMIT of a `WHERE embedding MATCH ? ORDER BY distance` query)
 * vec0 accepts — sqlite-vec's SQLITE_VEC_VEC0_K_MAX. One more and the query
 * throws `k value in knn query too large, provided N and the limit is 4096`
 * (measured on 0.1.7-alpha.2 and 0.1.9). A caller that grows k page by page
 * must stop here and work with the nearest 4,096 rows: asking for more does
 * not return more, it fails the whole search (2026-10-16: the consolidation
 * candidate search asked for 12,800 and stood still for 25 days).
 */
export declare const VEC0_KNN_K_MAX = 4096;
