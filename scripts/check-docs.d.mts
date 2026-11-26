export interface Fence {
  line: number;
  lang: string;
  body: string;
}
export function docFiles(root?: string): string[];
export function fences(source: string): Fence[];
export function unlabelledFences(root?: string): string[];
