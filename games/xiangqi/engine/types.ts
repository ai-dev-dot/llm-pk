export type Side = 'red' | 'black';
export type PieceType = 'rook'|'horse'|'elephant'|'advisor'|'general'|'cannon'|'pawn';
export interface Sq { file: number; rank: number }      // file 0..8, rank 0..9
const FILES = 'abcdefghi';
export const codeToSq = (s: string): Sq => ({ file: FILES.indexOf(s[0]), rank: Number(s.slice(1)) - 1 });
export const sqToCode = ({ file, rank }: Sq): string => FILES[file] + (rank + 1);
export const sqKey = (s: Sq) => `${s.file},${s.rank}`;