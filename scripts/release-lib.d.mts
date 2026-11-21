export interface ReleaseCommit {
  subject: string;
  body?: string;
  files?: string[];
}

export type Bump = 'major' | 'minor' | 'patch';

export declare const NO_RELEASE_TYPES: readonly string[];
export declare const SHIPPED_PATHS: readonly string[];
export declare function isShippedPath(path: string): boolean;
export declare function changedManifestFields(before: Record<string, unknown>, after: Record<string, unknown>): string[];
export declare const DEV_ONLY_SCRIPTS: readonly string[];
export declare const BUNDLED_DEV_DEPENDENCIES: readonly string[];
export declare function productionPackages(
  tree: Array<{ dependencies?: object; optionalDependencies?: object; devDependencies?: object }>,
  options?: { roots?: readonly string[] },
): string[];
export declare function changedPackages(before: string[], after: string[]): string[];
export declare function releaseReason(
  commits: ReleaseCommit[],
  options?: { manifestFields?: string[]; productionChanges?: string[] },
): string | null;
export declare function computeBump(commits: ReleaseCommit[]): Bump;
export declare function bumpVersion(version: string, bump: Bump): string;
export declare function renderChangelogSection(version: string, date: string, commits: ReleaseCommit[]): string;
export declare function insertChangelogSection(changelog: string, sectionText: string, version: string): string;
export declare function updateVersionMarkers(source: string, version: string): string;
