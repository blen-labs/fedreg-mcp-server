export interface ReleaseCommit {
  subject: string;
  body?: string;
}

export type Bump = 'major' | 'minor' | 'patch';

export declare function computeBump(commits: ReleaseCommit[]): Bump;
export declare function bumpVersion(version: string, bump: Bump): string;
export declare function renderChangelogSection(version: string, date: string, commits: ReleaseCommit[]): string;
export declare function insertChangelogSection(changelog: string, sectionText: string, version: string): string;
export declare function updateVersionMarkers(source: string, version: string): string;
