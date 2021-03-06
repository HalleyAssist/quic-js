/// <reference types="node" />
import { AddressInfo } from 'net';
import { BufferVisitor } from './common';
import { kVal } from './symbol';
export declare enum SessionType {
    SERVER = 0,
    CLIENT = 1
}
export declare enum FamilyType {
    IPv4 = "IPv4",
    IPv6 = "IPv6"
}
/**
 * Returns supported version.
 */
export declare function getVersion(): string;
/**
 * Returns supported versions array.
 */
export declare function getVersions(): string[];
/**
 * Chooses the best version in the overlap of ours and theirs.
 */
export declare function chooseVersion(theirs: string[]): string;
/**
 * Returns true if the server supports this version.
 */
export declare function isSupportedVersion(version: string): boolean;
/** Protocol representing a base protocol. */
export declare abstract class Protocol {
    static fromBuffer(_bufv: BufferVisitor, _len?: number): Protocol;
    protected readonly [kVal]: any;
    constructor(val: any);
    abstract equals(other: Protocol): boolean;
    abstract byteLen(arg?: any): number;
    abstract writeTo(bufv: BufferVisitor, arg?: any): BufferVisitor;
    abstract valueOf(): any;
    abstract toString(): string;
}
/** ConnectionID representing a connectionID. */
export declare class ConnectionID extends Protocol {
    static fromBuffer(bufv: BufferVisitor): ConnectionID;
    static random(): ConnectionID;
    constructor(id: string);
    /**
     * @return {string} - 16 length hex string
     */
    valueOf(): string;
    equals(other: ConnectionID): boolean;
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
    toString(): string;
}
/** PacketNumber representing a packetNumber. */
export declare class PacketNumber extends Protocol {
    static flagToByteLen(flagBits: number): number;
    static fromBuffer(bufv: BufferVisitor, len: number): PacketNumber;
    constructor(val: number);
    valueOf(): number;
    nextNumber(): PacketNumber;
    prevNumber(): PacketNumber;
    isLimitReached(): boolean;
    delta(other: PacketNumber): number;
    closestTo(a: PacketNumber, b: PacketNumber): PacketNumber;
    flagBits(): number;
    equals(other: PacketNumber): boolean;
    byteLen(isFull?: boolean): number;
    writeTo(bufv: BufferVisitor, isFull?: boolean): BufferVisitor;
    toString(): string;
}
/** StreamID representing a streamID. */
export declare class StreamID extends Protocol {
    /**
     * 2 bits -> 8/8, 16/8, 24/8, 32/8
     */
    static flagToByteLen(flagBits: number): number;
    static fromBuffer(bufv: BufferVisitor, len: number): StreamID;
    constructor(id: number);
    valueOf(): number;
    flagBits(): number;
    nextID(): StreamID;
    prevID(): StreamID;
    equals(other: StreamID): boolean;
    byteLen(isFull?: boolean): number;
    writeTo(bufv: BufferVisitor, isFull?: boolean): BufferVisitor;
    toString(): string;
}
/** Offset representing a data offset. */
export declare class Offset extends Protocol {
    /**
     * 3 bits -> 0, 16/8, 24/8, 32/8, 40/8, 48/8, 56/8, 64/8
     */
    static flagToByteLen(flagBits: number): number;
    static fromBuffer(bufv: BufferVisitor, len: number): Offset;
    constructor(offset: number);
    valueOf(): number;
    equals(other: Offset): boolean;
    gt(other: Offset): boolean;
    byteLen(isFull?: boolean): number;
    /**
     * 0, 16/8, 24/8, 32/8, 40/8, 48/8, 56/8, 64/8 -> 3 bits
     */
    flagBits(): number;
    writeTo(bufv: BufferVisitor, isFull?: boolean): BufferVisitor;
    toString(): string;
}
/** SocketAddress representing a socket address. */
export declare class SocketAddress extends Protocol {
    static fromBuffer(bufv: BufferVisitor): SocketAddress;
    port: number;
    address: string;
    family: FamilyType;
    constructor(obj: AddressInfo);
    valueOf(): {
        address: string;
        family: string;
        port: number;
    };
    equals(other: SocketAddress): boolean;
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
    toString(): string;
}
/** QuicTags representing a QUIC tag. */
export declare class QuicTags extends Protocol {
    static fromBuffer(bufv: BufferVisitor): QuicTags;
    name: Tag;
    tags: Map<Tag, Buffer>;
    constructor(name: Tag);
    valueOf(): {
        name: string;
        tags: any;
    };
    readonly size: number;
    [Symbol.iterator](): IterableIterator<[Tag, Buffer]>;
    set(key: Tag, val: Buffer): void;
    get(key: Tag): Buffer | null;
    has(key: Tag): boolean;
    equals(other: QuicTags): boolean;
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
    toString(): string;
}
export declare enum Tag {
    CHLO,
    SHLO,
    SCFG,
    REJ,
    SREJ,
    CETV,
    PRST,
    SCUP,
    ALPN,
    P256,
    C255,
    AESG,
    CC20,
    SRBF,
    QBIC,
    AFCW,
    IFW5,
    IFW6,
    IFW7,
    IFW8,
    IFW9,
    IFWA,
    TBBR,
    '1RTT',
    '2RTT',
    LRTT,
    BBRR,
    BBR1,
    BBR2,
    RENO,
    TPCC,
    BYTE,
    IW03,
    IW10,
    IW20,
    IW50,
    '1CON',
    NTLP,
    NCON,
    NRTO,
    UNDO,
    TIME,
    ATIM,
    MIN1,
    MIN4,
    TLPR,
    ACKD,
    AKD2,
    AKD3,
    AKD4,
    AKDU,
    SSLR,
    NPRR,
    '5RTO',
    '3RTO',
    CTIM,
    DHDT,
    CONH,
    LFAK,
    SMHL,
    CCVX,
    CBQT,
    BLMX,
    CPAU,
    NSTP,
    TCID,
    MPTH,
    NCMR,
    BWRE,
    BWMX,
    BWRS,
    BWS2,
    MTUH,
    MTUL,
    ASYN,
    SYNC,
    FHL2,
    X509,
    X59R,
    CHID,
    VER,
    NONC,
    NONP,
    KEXS,
    AEAD,
    COPT,
    CLOP,
    ICSL,
    SCLS,
    MSPC,
    MIDS,
    IRTT,
    SWND,
    SNI,
    PUBS,
    SCID,
    ORBT,
    PDMD,
    PROF,
    CCS,
    CCRT,
    EXPY,
    STTL,
    SFCW,
    CFCW,
    UAID,
    XLCT,
    TBKP,
    TB10,
    RREJ,
    RCID,
    CADR,
    ASAD,
    CIDK,
    CIDS,
    RNON,
    RSEQ,
    PAD,
    SPSH,
    SNO,
    STK,
    CRT,
    CSCT
}
