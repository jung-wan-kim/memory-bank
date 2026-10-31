import fs from 'fs';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { SUMMARIZER_CONTEXT_MARKER } from './constants.js';
import { getExcludedProjects, isExcludedProject, isWorkerPromptMessage, detectCodingAgent } from './paths.js';
import { archiveFileExists, readArchiveFile, resolveArchiveFile, statArchiveFile } from './archive-io.js';
import { getMaxMessageBytes, isOversizeExchange } from './message-size.js';
const EXCLUSION_MARKERS = [
    '<INSTRUCTIONS-TO-EPISODIC-MEMORY>DO NOT INDEX THIS CHAT</INSTRUCTIONS-TO-EPISODIC-MEMORY>',
    'Only use NO_INSIGHTS_FOUND',
    SUMMARIZER_CONTEXT_MARKER,
];
const MARKER_SCAN_CHUNK_BYTES = 1 << 20; // 1 MiB
/**
 * Stream the file looking for an exclusion marker, carrying an overlap between
 * chunks so a marker split across a boundary is still found (obra #152).
 * readFileSync(…, 'utf-8') throws ERR_STRING_TOO_LONG above ~512 MB, and the
 * old catch returned false — a large transcript was indexed without its
 * DO NOT INDEX marker ever being read. A read error now fails closed (skip).
 * `.zst` archives are capped by the decompression limit, so they are read whole.
 */
export function shouldSkipConversation(filePath) {
    const resolved = resolveArchiveFile(filePath);
    if (!resolved)
        return true;
    if (resolved !== filePath) {
        try {
            const content = readArchiveFile(filePath);
            return EXCLUSION_MARKERS.some(marker => content.includes(marker));
        }
        catch {
            return true;
        }
    }
    const maxMarkerLen = Math.max(...EXCLUSION_MARKERS.map(m => m.length));
    let fd;
    try {
        fd = fs.openSync(filePath, 'r');
        const buf = Buffer.allocUnsafe(MARKER_SCAN_CHUNK_BYTES);
        const decoder = new StringDecoder('utf8');
        let carry = '';
        let bytesRead;
        while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
            const window = carry + decoder.write(buf.subarray(0, bytesRead));
            if (EXCLUSION_MARKERS.some(marker => window.includes(marker)))
                return true;
            carry = window.slice(Math.max(0, window.length - (maxMarkerLen - 1)));
        }
        const tail = carry + decoder.end();
        return EXCLUSION_MARKERS.some(marker => tail.includes(marker));
    }
    catch {
        return true;
    }
    finally {
        if (fd !== undefined) {
            try {
                fs.closeSync(fd);
            }
            catch { /* best effort */ }
        }
    }
}
/** MEMORY_BANK_SKIP_SUMMARIES=1 skips the summary pass (obra #159) — for a nightly batch to own it. */
function summariesDisabled(env = process.env) {
    const v = env.MEMORY_BANK_SKIP_SUMMARIES;
    return v === '1' || v === 'true';
}
function copyIfNewer(src, dest) {
    // Ensure destination directory exists
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }
    // Check if destination exists and is up-to-date. The archive may have been
    // compressed out-of-band (dest.zst) — treat a current compressed copy as
    // up-to-date, otherwise every sync re-copies the whole history.
    const destStat = statArchiveFile(dest);
    if (destStat) {
        const srcStat = fs.statSync(src);
        if (destStat.mtimeMs >= srcStat.mtimeMs) {
            return false; // Dest (plain or compressed) is current, skip
        }
    }
    // Atomic copy: temp file + rename. FICLONE makes it a copy-on-write clone on
    // APFS (no data copied — live transcripts reach 1 GB and change every few
    // minutes); Node falls back to a byte copy where cloning is unsupported.
    const tempDest = dest + '.tmp.' + process.pid;
    try {
        fs.copyFileSync(src, tempDest, fs.constants.COPYFILE_FICLONE);
        fs.renameSync(tempDest, dest); // Atomic on same filesystem
    }
    catch (e) {
        try {
            fs.unlinkSync(tempDest);
        }
        catch { /* cleanup best effort */ }
        throw e;
    }
    return true;
}
function extractSessionIdFromPath(filePath) {
    // Extract session ID from filename: /path/to/abc-123-def.jsonl -> abc-123-def
    const basename = path.basename(filePath, '.jsonl');
    // Session IDs are UUIDs, validate format
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(basename)) {
        return basename;
    }
    return null;
}
export async function syncConversations(sourceDir, destDir, options = {}) {
    const result = {
        copied: 0,
        skipped: 0,
        indexed: 0,
        summarized: 0,
        errors: []
    };
    // Detect coding agent from source directory or use override
    const codingAgent = options.codingAgent || detectCodingAgent(sourceDir);
    // Ensure source directory exists
    if (!fs.existsSync(sourceDir)) {
        return result;
    }
    // Collect files to index and summarize
    const filesToIndex = [];
    const filesToSummarize = [];
    // Summary candidates are only stat'ed during the walk. Marker-scanning every
    // unsummarized transcript each run read the whole backlog (measured: 13k
    // files, 16.8 GB per sync) to pick at most summaryLimit of them.
    const summaryCandidates = [];
    const skipSummaries = options.skipSummaries || summariesDisabled();
    // Walk source directory
    const projects = fs.readdirSync(sourceDir);
    const excludedProjects = getExcludedProjects();
    for (const project of projects) {
        if (isExcludedProject(project, excludedProjects)) {
            console.error("\nSkipping excluded project: " + project);
            continue;
        }
        const projectPath = path.join(sourceDir, project);
        const stat = fs.statSync(projectPath);
        if (!stat.isDirectory())
            continue;
        const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
        for (const file of files) {
            const srcFile = path.join(projectPath, file);
            const destFile = path.join(destDir, project, file);
            try {
                const wasCopied = copyIfNewer(srcFile, destFile);
                if (wasCopied) {
                    result.copied++;
                    filesToIndex.push(destFile);
                }
                else {
                    result.skipped++;
                }
                // Check if this file needs a summary (whether newly copied or existing)
                if (!skipSummaries) {
                    const summaryPath = destFile.replace('.jsonl', '-summary.txt');
                    if (!archiveFileExists(summaryPath)) {
                        const sessionId = extractSessionIdFromPath(destFile);
                        // Source mtime: the archive copy carries the time it was copied.
                        if (sessionId && archiveFileExists(destFile)) {
                            summaryCandidates.push({ path: destFile, sessionId, mtimeMs: fs.statSync(srcFile).mtimeMs });
                        }
                    }
                }
            }
            catch (error) {
                result.errors.push({
                    file: srcFile,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
    }
    // Newest first, marker-scanned lazily until the per-run limit is filled.
    const summaryLimit = options.summaryLimit ?? 10;
    summaryCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let summaryBacklog = 0;
    for (const candidate of summaryCandidates) {
        if (filesToSummarize.length >= summaryLimit) {
            summaryBacklog++;
            continue;
        }
        if (!shouldSkipConversation(candidate.path)) {
            filesToSummarize.push({ path: candidate.path, sessionId: candidate.sessionId });
        }
    }
    // Index copied files (unless skipIndex is set)
    if (!options.skipIndex && filesToIndex.length > 0) {
        const { initDatabase, insertExchange, getResumeLine, deleteSupersededExchanges } = await import('./db.js');
        const { initEmbeddings, generateExchangeEmbedding } = await import('./embeddings.js');
        const { parseConversation } = await import('./parser.js');
        const db = initDatabase();
        await initEmbeddings();
        const maxMessageBytes = getMaxMessageBytes();
        let oversizeSkipped = 0;
        for (const file of filesToIndex) {
            try {
                // Check for DO NOT INDEX marker
                if (shouldSkipConversation(file)) {
                    continue; // Skip indexing but file is already copied
                }
                // Incremental: a grown transcript used to re-embed every exchange on
                // every sync (obra #152), so cost grew with session length. Resume at
                // the last indexed exchange's line_start — not MAX(line_end) as obra
                // does — so a reply still streaming at the previous sync is re-read
                // whole instead of staying cut off.
                const resumeLine = getResumeLine(db, file);
                const project = path.basename(path.dirname(file));
                const exchanges = await parseConversation(file, project, file);
                const pending = resumeLine > 0
                    ? exchanges.filter(e => e.lineStart >= resumeLine)
                    : exchanges;
                const writtenIds = [];
                try {
                    for (const exchange of pending) {
                        // Worker-prompt exchange = ephemeral state, not knowledge — never index.
                        if (isWorkerPromptMessage(exchange.userMessage))
                            continue;
                        if (isOversizeExchange(exchange, maxMessageBytes)) {
                            oversizeSkipped++;
                            continue;
                        }
                        // Tag each exchange with the coding agent
                        exchange.codingAgent = codingAgent;
                        const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
                        const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
                        insertExchange(db, exchange, embedding, toolNames);
                        writtenIds.push(exchange.id);
                    }
                }
                finally {
                    // Also after a failure part-way: once later rows land, the next
                    // resume point moves past resumeLine and a cut-off row left here
                    // would never be cleaned. Dropping a not-yet-rewritten row is safe —
                    // the resume point falls back and the next sync re-reads it.
                    if (resumeLine > 0) {
                        deleteSupersededExchanges(db, file, resumeLine, writtenIds);
                    }
                }
                result.indexed++;
            }
            catch (error) {
                result.errors.push({
                    file,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
        db.close();
        if (oversizeSkipped > 0) {
            console.error(`  Skipped ${oversizeSkipped} oversize exchange(s) (> ${maxMessageBytes} bytes; set MEMORY_BANK_MAX_MESSAGE_BYTES to change)`);
        }
    }
    // Generate summaries for files that need them
    if (!skipSummaries && filesToSummarize.length > 0) {
        const { parseConversation } = await import('./parser.js');
        const { summarizeConversation } = await import('./summarizer.js');
        console.error(`Generating summaries for ${filesToSummarize.length} conversation(s)...`);
        if (summaryBacklog > 0) {
            console.error(`  (${summaryBacklog} more need summaries - will process on next sync)`);
        }
        for (const { path: filePath } of filesToSummarize) {
            try {
                const project = path.basename(path.dirname(filePath));
                const exchanges = await parseConversation(filePath, project, filePath);
                if (exchanges.length === 0) {
                    continue; // Skip empty conversations
                }
                console.error(`  Summarizing ${path.basename(filePath)} (${exchanges.length} exchanges)...`);
                const summary = await summarizeConversation(exchanges);
                const summaryPath = filePath.replace('.jsonl', '-summary.txt');
                fs.writeFileSync(summaryPath, summary, 'utf-8');
                result.summarized++;
            }
            catch (error) {
                result.errors.push({
                    file: filePath,
                    error: `Summary generation failed: ${error instanceof Error ? error.message : String(error)}`
                });
            }
        }
    }
    return result;
}
