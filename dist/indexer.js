import fs from 'fs';
import path from 'path';
import { initDatabase, insertExchange } from './db.js';
import { parseConversation } from './parser.js';
import { initEmbeddings, generateExchangeEmbedding } from './embeddings.js';
import { summarizeConversation } from './summarizer.js';
import { getArchiveDir, getExcludedProjects, isExcludedProject, isWorkerPromptMessage, getProjectsDir, isRetainedSource } from './paths.js';
import { archiveFileExists, statArchiveFile } from './archive-io.js';
/**
 * Copy source → archive unless a current copy (plain or .zst) already exists.
 * A stale compressed copy must not mask a newer source file.
 */
function archiveIfStale(sourcePath, archivePath) {
    const destStat = statArchiveFile(archivePath);
    if (destStat && destStat.mtimeMs >= fs.statSync(sourcePath).mtimeMs) {
        return false;
    }
    fs.copyFileSync(sourcePath, archivePath);
    return true;
}
// Set max output tokens for Claude SDK (used by summarizer)
process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '20000';
// Increase max listeners for concurrent API calls
import { EventEmitter } from 'events';
EventEmitter.defaultMaxListeners = 20;
// Projects dir (with TEST_PROJECTS_DIR override) now lives in paths.ts.
// Process items in batches with limited concurrency
export async function processBatch(items, processor, concurrency) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
        const batch = items.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(processor));
        results.push(...batchResults);
    }
    return results;
}
export async function indexConversations(limitToProject, maxConversations, concurrency = 1, noSummaries = false) {
    console.log('Initializing database...');
    const db = initDatabase();
    console.log('Loading embedding model...');
    await initEmbeddings();
    if (noSummaries) {
        console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');
    }
    console.log('Scanning for conversation files...');
    const PROJECTS_DIR = getProjectsDir();
    const ARCHIVE_DIR = getArchiveDir(); // Now uses paths.ts
    const projects = fs.readdirSync(PROJECTS_DIR);
    let totalExchanges = 0;
    let conversationsProcessed = 0;
    const excludedProjects = getExcludedProjects();
    for (const project of projects) {
        // Skip excluded projects (user list + built-in LLM worker sessions)
        if (isExcludedProject(project, excludedProjects)) {
            console.log(`\nSkipping excluded project: ${project}`);
            continue;
        }
        // Skip if limiting to specific project
        if (limitToProject && project !== limitToProject)
            continue;
        const projectPath = path.join(PROJECTS_DIR, project);
        const stat = fs.statSync(projectPath);
        if (!stat.isDirectory())
            continue;
        const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl')).filter(f => isRetainedSource(path.join(projectPath, f)));
        if (files.length === 0)
            continue;
        console.log(`\nProcessing project: ${project} (${files.length} conversations)`);
        if (concurrency > 1)
            console.log(`  Concurrency: ${concurrency}`);
        // Create archive directory for this project
        const projectArchive = path.join(ARCHIVE_DIR, project);
        fs.mkdirSync(projectArchive, { recursive: true });
        const toProcess = [];
        for (const file of files) {
            const sourcePath = path.join(projectPath, file);
            const archivePath = path.join(projectArchive, file);
            // Copy to archive (skip when a current plain or compressed copy exists)
            if (archiveIfStale(sourcePath, archivePath)) {
                console.log(`  Archived: ${file}`);
            }
            // Parse conversation
            const exchanges = await parseConversation(sourcePath, project, archivePath);
            if (exchanges.length === 0) {
                console.log(`  Skipped ${file} (no exchanges)`);
                continue;
            }
            toProcess.push({
                file,
                sourcePath,
                archivePath,
                summaryPath: archivePath.replace('.jsonl', '-summary.txt'),
                exchanges
            });
        }
        // Batch summarize conversations in parallel (unless --no-summaries)
        if (!noSummaries) {
            const needsSummary = toProcess.filter(c => !archiveFileExists(c.summaryPath));
            if (needsSummary.length > 0) {
                console.log(`  Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...`);
                await processBatch(needsSummary, async (conv) => {
                    try {
                        const summary = await summarizeConversation(conv.exchanges);
                        fs.writeFileSync(conv.summaryPath, summary, 'utf-8');
                        const wordCount = summary.split(/\s+/).length;
                        console.log(`  ✓ ${conv.file}: ${wordCount} words`);
                        return summary;
                    }
                    catch (error) {
                        console.log(`  ✗ ${conv.file}: ${error}`);
                        return null;
                    }
                }, concurrency);
            }
        }
        else {
            console.log(`  Skipping ${toProcess.length} summaries (--no-summaries mode)`);
        }
        // Now process embeddings and DB inserts (fast, sequential is fine)
        for (const conv of toProcess) {
            for (const exchange of conv.exchanges) {
                // The plugin's own worker-prompt sessions are ephemeral state, not
                // knowledge — never index them (legacy transcripts sit under REAL
                // project slugs, so the slug exclusion can't catch them).
                if (isWorkerPromptMessage(exchange.userMessage))
                    continue;
                const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
                const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
                insertExchange(db, exchange, embedding, toolNames);
            }
            totalExchanges += conv.exchanges.length;
            conversationsProcessed++;
            // Check if we hit the limit
            if (maxConversations && conversationsProcessed >= maxConversations) {
                console.log(`\nReached limit of ${maxConversations} conversations`);
                db.close();
                console.log(`✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`);
                return;
            }
        }
    }
    db.close();
    console.log(`\n✅ Indexing complete! Conversations: ${conversationsProcessed}, Exchanges: ${totalExchanges}`);
}
export async function indexSession(sessionId, concurrency = 1, noSummaries = false) {
    const startedAt = Date.now();
    console.log(`Indexing session: ${sessionId}`);
    // Find the conversation file for this session
    const PROJECTS_DIR = getProjectsDir();
    const ARCHIVE_DIR = getArchiveDir(); // Now uses paths.ts
    const projects = fs.readdirSync(PROJECTS_DIR);
    const excludedProjects = getExcludedProjects();
    for (const project of projects) {
        if (isExcludedProject(project, excludedProjects))
            continue;
        const projectPath = path.join(PROJECTS_DIR, project);
        if (!fs.statSync(projectPath).isDirectory())
            continue;
        const files = fs.readdirSync(projectPath).filter(f => f.includes(sessionId) && f.endsWith('.jsonl')).filter(f => isRetainedSource(path.join(projectPath, f)));
        if (files.length > 0) {
            const file = files[0];
            const sourcePath = path.join(projectPath, file);
            const db = initDatabase();
            try {
                await initEmbeddings();
                const projectArchive = path.join(ARCHIVE_DIR, project);
                fs.mkdirSync(projectArchive, { recursive: true });
                const archivePath = path.join(projectArchive, file);
                // Archive
                archiveIfStale(sourcePath, archivePath);
                // Parse and summarize
                const exchanges = await parseConversation(sourcePath, project, archivePath);
                const indexableExchanges = exchanges.filter(exchange => !isWorkerPromptMessage(exchange.userMessage));
                if (indexableExchanges.length === 0) {
                    console.log(`Session ${sessionId} has no indexable exchanges`);
                    return {
                        status: 'no_indexable_exchanges',
                        sessionId,
                        startedAt,
                        sourcePath,
                    };
                }
                // Generate summary (unless --no-summaries)
                const summaryPath = archivePath.replace('.jsonl', '-summary.txt');
                if (!noSummaries && !archiveFileExists(summaryPath)) {
                    const summary = await summarizeConversation(exchanges);
                    fs.writeFileSync(summaryPath, summary, 'utf-8');
                    console.log(`Summary: ${summary.split(/\s+/).length} words`);
                }
                // Index
                for (const exchange of indexableExchanges) {
                    const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
                    const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
                    insertExchange(db, exchange, embedding, toolNames);
                }
                const expectedFrontier = Math.max(...indexableExchanges.map(exchange => exchange.lineEnd));
                console.log(`✅ Indexed session ${sessionId}: ${indexableExchanges.length} exchanges`);
                return {
                    status: 'indexed',
                    sessionId,
                    startedAt,
                    sourcePath,
                    expectedExchangeCount: indexableExchanges.length,
                    expectedFrontier,
                };
            }
            finally {
                db.close();
            }
        }
    }
    console.log(`Session ${sessionId} not found`);
    return { status: 'not_found', sessionId, startedAt };
}
export async function indexUnprocessed(concurrency = 1, noSummaries = false) {
    console.log('Finding unprocessed conversations...');
    if (concurrency > 1)
        console.log(`Concurrency: ${concurrency}`);
    if (noSummaries)
        console.log('⚠️  Running in no-summaries mode (skipping AI summaries)');
    const db = initDatabase();
    await initEmbeddings();
    const PROJECTS_DIR = getProjectsDir();
    const ARCHIVE_DIR = getArchiveDir(); // Now uses paths.ts
    const projects = fs.readdirSync(PROJECTS_DIR);
    const excludedProjects = getExcludedProjects();
    const unprocessed = [];
    // Collect all unprocessed conversations
    for (const project of projects) {
        if (isExcludedProject(project, excludedProjects))
            continue;
        const projectPath = path.join(PROJECTS_DIR, project);
        if (!fs.statSync(projectPath).isDirectory())
            continue;
        const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.jsonl')).filter(f => isRetainedSource(path.join(projectPath, f)));
        for (const file of files) {
            const sourcePath = path.join(projectPath, file);
            const projectArchive = path.join(ARCHIVE_DIR, project);
            const archivePath = path.join(projectArchive, file);
            const summaryPath = archivePath.replace('.jsonl', '-summary.txt');
            // Check if already indexed in database
            const alreadyIndexed = db.prepare('SELECT COUNT(*) as count FROM exchanges WHERE archive_path = ?')
                .get(archivePath);
            if (alreadyIndexed.count > 0)
                continue;
            fs.mkdirSync(projectArchive, { recursive: true });
            // Archive if needed (a current plain or compressed copy counts)
            archiveIfStale(sourcePath, archivePath);
            // Parse and check
            const exchanges = await parseConversation(sourcePath, project, archivePath);
            if (exchanges.length === 0)
                continue;
            unprocessed.push({ project, file, sourcePath, archivePath, summaryPath, exchanges });
        }
    }
    if (unprocessed.length === 0) {
        console.log('✅ All conversations are already processed!');
        db.close();
        return;
    }
    console.log(`Found ${unprocessed.length} unprocessed conversations`);
    // Batch process summaries (unless --no-summaries)
    if (!noSummaries) {
        const needsSummary = unprocessed.filter(c => !archiveFileExists(c.summaryPath));
        if (needsSummary.length > 0) {
            console.log(`Generating ${needsSummary.length} summaries (concurrency: ${concurrency})...\n`);
            await processBatch(needsSummary, async (conv) => {
                try {
                    const summary = await summarizeConversation(conv.exchanges);
                    fs.writeFileSync(conv.summaryPath, summary, 'utf-8');
                    const wordCount = summary.split(/\s+/).length;
                    console.log(`  ✓ ${conv.project}/${conv.file}: ${wordCount} words`);
                    return summary;
                }
                catch (error) {
                    console.log(`  ✗ ${conv.project}/${conv.file}: ${error}`);
                    return null;
                }
            }, concurrency);
        }
    }
    else {
        console.log(`Skipping summaries for ${unprocessed.length} conversations (--no-summaries mode)\n`);
    }
    // Now index embeddings
    console.log(`\nIndexing embeddings...`);
    for (const conv of unprocessed) {
        for (const exchange of conv.exchanges) {
            if (isWorkerPromptMessage(exchange.userMessage))
                continue; // worker prompt = ephemeral state, not knowledge
            const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
            const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
            insertExchange(db, exchange, embedding, toolNames);
        }
    }
    db.close();
    console.log(`\n✅ Processed ${unprocessed.length} conversations`);
}
