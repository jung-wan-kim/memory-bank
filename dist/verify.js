import fs from 'fs';
import path from 'path';
import { parseConversation } from './parser.js';
import { initDatabase, getAllExchanges, getFileLastIndexed } from './db.js';
import { getArchiveDir, getExcludedProjects, isExcludedProject } from './paths.js';
import { archiveFileExists, canonicalArchiveName, removeArchiveFile, statArchiveFile } from './archive-io.js';
export async function verifyIndex() {
    const result = {
        missing: [],
        orphaned: [],
        outdated: [],
        corrupted: []
    };
    const archiveDir = getArchiveDir();
    // Track all files we find
    const foundFiles = new Set();
    // Find all conversation files
    if (!fs.existsSync(archiveDir)) {
        return result;
    }
    // Initialize database once for all checks
    const db = initDatabase();
    const projects = fs.readdirSync(archiveDir);
    const excludedProjects = getExcludedProjects();
    let totalChecked = 0;
    for (const project of projects) {
        if (isExcludedProject(project, excludedProjects)) {
            console.log("\nSkipping excluded project: " + project);
            continue;
        }
        const projectPath = path.join(archiveDir, project);
        const stat = fs.statSync(projectPath);
        if (!stat.isDirectory())
            continue;
        // Archive files may be compressed out-of-band (.jsonl.zst) — canonicalize
        // to the .jsonl name the database stores.
        const files = [...new Set(fs.readdirSync(projectPath)
                .filter(f => f.endsWith('.jsonl') || f.endsWith('.jsonl.zst'))
                .map(f => canonicalArchiveName(f)))];
        for (const file of files) {
            totalChecked++;
            if (totalChecked % 100 === 0) {
                console.log(`  Checked ${totalChecked} conversations...`);
            }
            const conversationPath = path.join(projectPath, file);
            foundFiles.add(conversationPath);
            const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
            // Check for missing summary
            if (!archiveFileExists(summaryPath)) {
                result.missing.push({ path: conversationPath, reason: 'No summary file' });
                continue;
            }
            // Check if file is outdated (modified after last_indexed)
            const lastIndexed = getFileLastIndexed(db, conversationPath);
            if (lastIndexed !== null) {
                const fileStat = statArchiveFile(conversationPath);
                if (fileStat && fileStat.mtimeMs > lastIndexed) {
                    result.outdated.push({
                        path: conversationPath,
                        fileTime: fileStat.mtimeMs,
                        dbTime: lastIndexed
                    });
                }
            }
            // Try parsing to detect corruption
            try {
                await parseConversation(conversationPath, project, conversationPath);
            }
            catch (error) {
                result.corrupted.push({
                    path: conversationPath,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
    }
    console.log(`Verified ${totalChecked} conversations.`);
    // Check for orphaned database entries
    const dbExchanges = getAllExchanges(db);
    db.close();
    for (const exchange of dbExchanges) {
        if (!foundFiles.has(exchange.archivePath)) {
            result.orphaned.push({
                uuid: exchange.id,
                path: exchange.archivePath
            });
        }
    }
    return result;
}
export async function repairIndex(issues) {
    console.log('Repairing index...');
    // To avoid circular dependencies, we import the indexer functions dynamically
    const { initDatabase, insertExchange, deleteExchange } = await import('./db.js');
    const { parseConversation } = await import('./parser.js');
    const { initEmbeddings, generateExchangeEmbedding } = await import('./embeddings.js');
    const { summarizeConversation, REFUSED_SUMMARY } = await import('./summarizer.js');
    const db = initDatabase();
    await initEmbeddings();
    // Remove orphaned entries first
    for (const orphan of issues.orphaned) {
        console.log(`Removing orphaned entry: ${orphan.uuid}`);
        deleteExchange(db, orphan.uuid);
    }
    // Re-index missing and outdated conversations
    const toReindex = [
        ...issues.missing.map(m => m.path),
        ...issues.outdated.map(o => o.path)
    ];
    for (const conversationPath of toReindex) {
        console.log(`Re-indexing: ${conversationPath}`);
        try {
            // Extract project name from path
            const archiveDir = getArchiveDir();
            const relativePath = conversationPath.replace(archiveDir + path.sep, '');
            const project = relativePath.split(path.sep)[0];
            // Parse conversation
            const exchanges = await parseConversation(conversationPath, project, conversationPath);
            if (exchanges.length === 0) {
                console.log(`  Skipped (no exchanges)`);
                continue;
            }
            // Generate/update summary
            // A failed summary must not block re-indexing the exchanges. The stale
            // summary is removed (plain and compressed): kept, it would never be
            // redone, since the file exists and the exchanges are indexed as current
            // again. A missing one is written by the next sync while the source
            // conversation is still in the projects dir, else by the next repair.
            const summaryPath = conversationPath.replace('.jsonl', '-summary.txt');
            try {
                const summary = await summarizeConversation(exchanges);
                if (summary === REFUSED_SUMMARY && archiveFileExists(summaryPath)) {
                    // An older summary of this conversation beats the refusal marker.
                    console.log(`  Summary refused, keeping the existing one`);
                }
                else {
                    fs.writeFileSync(summaryPath, summary, 'utf-8');
                    console.log(`  Created summary: ${summary.split(/\s+/).length} words`);
                }
            }
            catch (error) {
                removeArchiveFile(summaryPath);
                console.error(`  Summary failed (re-indexing continues; the summary is redone later): ${error instanceof Error ? error.message : String(error)}`);
            }
            // Index exchanges
            for (const exchange of exchanges) {
                const toolNames = exchange.toolCalls?.map(tc => tc.toolName);
                const embedding = await generateExchangeEmbedding(exchange.userMessage, exchange.assistantMessage, toolNames);
                insertExchange(db, exchange, embedding, toolNames);
            }
            console.log(`  Indexed ${exchanges.length} exchanges`);
        }
        catch (error) {
            console.error(`Failed to re-index ${conversationPath}:`, error);
        }
    }
    db.close();
    // Report corrupted files (manual intervention needed)
    if (issues.corrupted.length > 0) {
        console.log('\n⚠️  Corrupted files (manual review needed):');
        issues.corrupted.forEach(c => console.log(`  ${c.path}: ${c.error}`));
    }
    console.log('✅ Repair complete.');
}
