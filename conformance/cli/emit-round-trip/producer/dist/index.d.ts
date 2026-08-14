export declare function twice(n: number): number;
export declare function fetchOk(): Promise<number>;
export declare function each<T>(items: T[], visit: (item: T) => void): void;
export declare function widen(value: string): string;
export declare function widen(value: number): string;
export declare function register(handler: () => void): void;
export declare function latestHandler(): (() => void) | undefined;
export declare function isFlag(text: string): boolean;
