/** Every declared runtime dependency has a package.json in node_modules. */
export declare function depsPresent(root: string): boolean;
/** Take the lock, reclaiming one whose holder died or that is older than STALE_MS. */
export declare function acquireInstallLock(root: string): boolean;
/** Release only a lock this process holds — never one a reclaimer has since taken over. */
export declare function releaseInstallLock(root: string): void;
/**
 * Run `npm <args>` in root under the lock. If another process holds it, wait
 * for that install and report whether the deps are now present instead of
 * installing a second time.
 */
export declare function runNpmLocked(root: string, args: string[], label: string): boolean;
