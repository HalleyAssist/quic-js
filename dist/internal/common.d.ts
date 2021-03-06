/// <reference types="node" />
import { lookup } from 'dns';
export declare const dnsLookup: typeof lookup.__promisify__;
export declare class Visitor {
    start: number;
    end: number;
    constructor(start?: number, end?: number);
    reset(start?: number, end?: number): this;
    walk(steps: number): this;
}
export declare class BufferVisitor extends Visitor {
    buf: Buffer;
    constructor(buf: Buffer, start?: number, end?: number);
    readonly length: number;
    mustHas(steps: number, message?: string): void;
    mustWalk(steps: number, message?: string): void;
}
export interface ToBuffer {
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
}
export declare function toBuffer(obj: ToBuffer): Buffer;
export declare const Float16MaxValue = 4396972769280;
export declare function readUFloat16(buf: Buffer, offset?: number): number;
export declare function writeUFloat16(buf: Buffer, value: number, offset: number): Buffer;
export declare function readUnsafeUInt(buf: Buffer, offset: number, len: number): number;
export declare function writeUnsafeUInt(buf: Buffer, val: number, offset: number, len: number): Buffer;
export declare class Queue<T> {
    private tail;
    private head;
    private offset;
    private hLength;
    constructor();
    readonly length: number;
    first(): T | undefined;
    push(item: T): void;
    pop(): T | undefined;
    unshift(item: T): void;
    shift(): T | undefined;
    toArray(): T[];
    reset(): void;
    migrateTo(queue: Queue<T>): Queue<T>;
}
