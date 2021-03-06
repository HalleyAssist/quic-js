/// <reference types="node" />
import { BufferVisitor } from './common';
import { QUICError, QUICStreamError } from './error';
import { PacketNumber, Offset, StreamID } from './protocol';
export declare function isCongestionType(flag: number): boolean;
export declare function isACKType(flag: number): boolean;
export declare function isStreamType(flag: number): boolean;
export declare function parseFrame(bufv: BufferVisitor, headerPacketNumber: PacketNumber): Frame;
/** Frame representing a QUIC frame. */
export declare abstract class Frame {
    static fromBuffer(_bufv: BufferVisitor, _headerPacketNumber?: PacketNumber): Frame;
    type: number;
    name: string;
    constructor(type: number, name: string);
    valueOf(): {
        name: string;
        type: number;
    };
    toString(): string;
    isRetransmittable(): boolean;
    abstract byteLen(): number;
    abstract writeTo(bufv: BufferVisitor): BufferVisitor;
}
/** StreamFrame representing a QUIC STREAM frame. */
export declare class StreamFrame extends Frame {
    static fromBuffer(bufv: BufferVisitor): StreamFrame;
    streamID: StreamID;
    offset: Offset;
    isFIN: boolean;
    data: Buffer | null;
    constructor(streamID: StreamID, offset: Offset, isFIN?: boolean);
    setData(data: Buffer | null): this;
    valueOf(): {
        name: string;
        type: number;
        isFIN: boolean;
        streamID: number;
        offset: number;
        data: Buffer | null;
    };
    headerLen(hasDataLen: boolean): number;
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
}
/** AckRange representing a range for ACK. */
export declare class AckRange {
    last: number;
    first: number;
    constructor(firstPacketNumberValue: number, lastPacketNumberValue: number);
    len(): number;
}
/** AckFrame representing a QUIC ACK frame. */
export declare class AckFrame extends Frame {
    static fromBuffer(bufv: BufferVisitor): AckFrame;
    largestAcked: number;
    lowestAcked: number;
    ackRanges: AckRange[];
    delayTime: number;
    largestAckedTime: number;
    constructor();
    valueOf(): {
        name: string;
        type: number;
        largestAcked: number;
        lowestAcked: number;
        delayTime: number;
        ackRanges: AckRange[];
    };
    hasMissingRanges(): boolean;
    validateAckRanges(): boolean;
    numWritableNackRanges(): number;
    getMissingNumberDeltaFlagBits(): number;
    setDelay(): void;
    acksPacket(val: number): boolean;
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
}
/** StopWaitingFrame representing a QUIC STOP_WAITING frame. */
export declare class StopWaitingFrame extends Frame {
    static fromBuffer(bufv: BufferVisitor, packetNumber: PacketNumber): StopWaitingFrame;
    packetNumber: PacketNumber;
    leastUnacked: number;
    constructor(packetNumber: PacketNumber, leastUnacked: number);
    valueOf(): {
        name: string;
        type: number;
        packetNumber: number;
        leastUnacked: number;
    };
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
}
/** WindowUpdateFrame representing a QUIC WINDOW_UPDATE frame. */
export declare class WindowUpdateFrame extends Frame {
    static fromBuffer(bufv: BufferVisitor): WindowUpdateFrame;
    streamID: StreamID;
    offset: Offset;
    constructor(streamID: StreamID, offset: Offset);
    valueOf(): {
        name: string;
        type: number;
        streamID: number;
        offset: number;
    };
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
}
/** BlockedFrame representing a QUIC BLOCKED frame. */
export declare class BlockedFrame extends Frame {
    static fromBuffer(bufv: BufferVisitor): BlockedFrame;
    streamID: StreamID;
    constructor(streamID: StreamID);
    valueOf(): {
        name: string;
        type: number;
        streamID: number;
    };
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
}
/** CongestionFeedbackFrame representing a QUIC CONGESTION_FEEDBACK frame. */
export declare class CongestionFeedbackFrame extends Frame {
    static fromBuffer(bufv: BufferVisitor): CongestionFeedbackFrame;
    constructor();
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
}
/** PaddingFrame representing a QUIC PADDING frame. */
export declare class PaddingFrame extends Frame {
    static fromBuffer(bufv: BufferVisitor): PaddingFrame;
    constructor();
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
}
/** RstStreamFrame representing a QUIC RST_STREAM frame. */
export declare class RstStreamFrame extends Frame {
    static fromBuffer(bufv: BufferVisitor): RstStreamFrame;
    streamID: StreamID;
    offset: Offset;
    error: QUICStreamError;
    constructor(streamID: StreamID, offset: Offset, error: QUICStreamError);
    valueOf(): {
        name: string;
        type: number;
        streamID: number;
        offset: number;
        error: {
            name: string;
            code: number;
            message: string;
        };
    };
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
}
/** PingFrame representing a QUIC PING frame. */
export declare class PingFrame extends Frame {
    static fromBuffer(bufv: BufferVisitor): PingFrame;
    constructor();
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
}
/** ConnectionCloseFrame representing a QUIC CONNECTION_CLOSE frame. */
export declare class ConnectionCloseFrame extends Frame {
    static fromBuffer(bufv: BufferVisitor): ConnectionCloseFrame;
    error: QUICError;
    constructor(error: QUICError);
    valueOf(): {
        name: string;
        type: number;
        error: {
            name: string;
            code: number;
            message: string;
        };
    };
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
}
/** GoAwayFrame representing a QUIC GOAWAY frame. */
export declare class GoAwayFrame extends Frame {
    static fromBuffer(bufv: BufferVisitor): GoAwayFrame;
    streamID: StreamID;
    error: QUICError;
    constructor(lastGoodStreamID: StreamID, error: QUICError);
    valueOf(): {
        name: string;
        type: number;
        streamID: number;
        error: {
            name: string;
            code: number;
            message: string;
        };
    };
    byteLen(): number;
    writeTo(bufv: BufferVisitor): BufferVisitor;
}
