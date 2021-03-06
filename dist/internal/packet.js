'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
// **Github:** https://github.com/fidm/quic
//
// **License:** MIT
const util_1 = require("util");
const common_1 = require("./common");
const error_1 = require("./error");
const frame_1 = require("./frame");
const protocol_1 = require("./protocol");
// --- QUIC Public Packet Header
//
//      0        1        2        3        4            8
// +--------+--------+--------+--------+--------+---    ---+
// | Public |    Connection ID (64)    ...                 | ->
// |Flags(8)|      (optional)                              |
// +--------+--------+--------+--------+--------+---    ---+
//
//      9       10       11        12
// +--------+--------+--------+--------+
// |      QUIC Version (32)            | ->
// |         (optional)                |
// +--------+--------+--------+--------+
//
//     13       14       15        16      17       18       19       20
// +--------+--------+--------+--------+--------+--------+--------+--------+
// |                        Diversification Nonce                          | ->
// |                              (optional)                               |
// +--------+--------+--------+--------+--------+--------+--------+--------+
//
//     21       22       23        24      25       26       27       28
// +--------+--------+--------+--------+--------+--------+--------+--------+
// |                   Diversification Nonce Continued                     | ->
// |                              (optional)                               |
// +--------+--------+--------+--------+--------+--------+--------+--------+
//
//     29       30       31        32      33       34       35       36
// +--------+--------+--------+--------+--------+--------+--------+--------+
// |                   Diversification Nonce Continued                     | ->
// |                              (optional)                               |
// +--------+--------+--------+--------+--------+--------+--------+--------+
//
//     37       38       39        40      41       42       43       44
// +--------+--------+--------+--------+--------+--------+--------+--------+
// |                   Diversification Nonce Continued                     | ->
// |                              (optional)                               |
// +--------+--------+--------+--------+--------+--------+--------+--------+
//
//     45      46       47        48       49       50
// +--------+--------+--------+--------+--------+--------+
// |           Packet Number (8, 16, 32, or 48)          |
// |                  (variable length)                  |
// +--------+--------+--------+--------+--------+--------+
// ---
//
// Public Flags:
// 0x01 = PUBLIC_FLAG_VERSION. Interpretation of this flag depends on whether the packet
//   is sent by the server or the client. When sent by the client, setting it indicates that
//   the header contains a QUIC Version (see below)...
// 0x02 = PUBLIC_FLAG_RESET. Set to indicate that the packet is a Public Reset packet.
// 0x04 = Indicates the presence of a 32 byte diversification nonce in the header.
// 0x08 = Indicates the full 8 byte Connection ID is present in the packet.
// Two bits at 0x30 indicate the number of low-order-bytes of the packet number that
// are present in each packet. The bits are only used for Frame Packets. For Public Reset
// and Version Negotiation Packets (sent by the server) which don't have a packet number,
// these bits are not used and must be set to 0. Within this 2 bit mask:
//   0x30 indicates that 6 bytes of the packet number is present
//   0x20 indicates that 4 bytes of the packet number is present
//   0x10 indicates that 2 bytes of the packet number is present
//   0x00 indicates that 1 byte of the packet number is present
// 0x40 is reserved for multipath use.
// 0x80 is currently unused, and must be set to 0.
function parsePacket(bufv, packetSentBy) {
    bufv.walk(0); // align start and end
    const flag = bufv.buf.readUInt8(bufv.start);
    // 0x80, currently unused
    if (flag >= 127) {
        throw new error_1.QuicError('QUIC_INTERNAL_ERROR');
    }
    // 0x08, connectionID
    if ((flag & 0b1000) === 0) {
        throw new error_1.QuicError('QUIC_INTERNAL_ERROR');
    }
    if ((flag & 0b10) > 0) { // Reset Packet
        return ResetPacket.fromBuffer(bufv);
    }
    const hasVersion = (flag & 0b1) > 0;
    if (hasVersion && packetSentBy === protocol_1.SessionType.SERVER) { // Negotiation Packet
        return NegotiationPacket.fromBuffer(bufv);
    }
    return RegularPacket.fromBuffer(bufv, flag, packetSentBy);
}
exports.parsePacket = parsePacket;
/** Packet representing a base Packet. */
class Packet {
    static fromBuffer(_bufv, _flag, _packetSentBy) {
        throw new Error(`class method "fromBuffer" is not implemented`);
    }
    constructor(connectionID, flag) {
        this.flag = flag;
        this.connectionID = connectionID;
        this.sentTime = 0; // timestamp, ms
    }
    isReset() {
        return this instanceof ResetPacket;
    }
    isNegotiation() {
        return this instanceof NegotiationPacket;
    }
    isRegular() {
        return this instanceof RegularPacket;
    }
    valueOf() {
        return {
            connectionID: this.connectionID.valueOf(),
            flag: this.flag,
        };
    }
    toString() {
        return JSON.stringify(this.valueOf());
    }
    [util_1.inspect.custom](_depth, _options) {
        return `<${this.constructor.name} ${this.toString()}>`;
    }
}
exports.Packet = Packet;
/** ResetPacket representing a reset Packet. */
class ResetPacket extends Packet {
    // --- Public Reset Packet
    //      0        1        2        3        4         8
    // +--------+--------+--------+--------+--------+--   --+
    // | Public |    Connection ID (64)                ...  | ->
    // |Flags(8)|                                           |
    // +--------+--------+--------+--------+--------+--   --+
    //
    //      9       10       11        12       13      14
    // +--------+--------+--------+--------+--------+--------+---
    // |      Quic Tag (32)                |  Tag value map      ... ->
    // |         (PRST)                    |  (variable length)
    // +--------+--------+--------+--------+--------+--------+---
    static fromBuffer(bufv) {
        bufv.walk(1); // flag
        const connectionID = protocol_1.ConnectionID.fromBuffer(bufv);
        const quicTag = protocol_1.QuicTags.fromBuffer(bufv);
        if (quicTag.name !== protocol_1.Tag.PRST || !quicTag.has(protocol_1.Tag.RNON)) {
            throw new error_1.QuicError('QUIC_INVALID_PUBLIC_RST_PACKET');
        }
        return new ResetPacket(connectionID, quicTag);
    }
    constructor(connectionID, tags) {
        super(connectionID, 0b00001010);
        this.tags = tags;
        this.packetNumber = null;
        this.socketAddress = null;
        const nonceProof = tags.get(protocol_1.Tag.RNON);
        if (nonceProof == null) {
            throw new error_1.QuicError('QUIC_INVALID_PUBLIC_RST_PACKET');
        }
        this.nonceProof = nonceProof;
        const rseq = tags.get(protocol_1.Tag.RSEQ);
        if (rseq != null) {
            this.packetNumber = protocol_1.PacketNumber.fromBuffer(new common_1.BufferVisitor(rseq), rseq.length);
        }
        const cadr = tags.get(protocol_1.Tag.CADR);
        if (cadr != null) {
            this.socketAddress = protocol_1.SocketAddress.fromBuffer(new common_1.BufferVisitor(cadr));
        }
    }
    valueOf() {
        return {
            connectionID: this.connectionID.valueOf(),
            flag: this.flag,
            packetNumber: this.packetNumber == null ? null : this.packetNumber.valueOf(),
            socketAddress: this.socketAddress == null ? null : this.socketAddress.valueOf(),
            nonceProof: this.nonceProof,
        };
    }
    byteLen() {
        return 9 + this.tags.byteLen();
    }
    writeTo(bufv) {
        bufv.walk(1);
        bufv.buf.writeUInt8(this.flag, bufv.start);
        this.connectionID.writeTo(bufv);
        this.tags.writeTo(bufv);
        return bufv;
    }
}
exports.ResetPacket = ResetPacket;
/** NegotiationPacket representing a negotiation Packet. */
class NegotiationPacket extends Packet {
    // --- Version Negotiation Packet
    //      0        1        2        3        4        5        6        7       8
    // +--------+--------+--------+--------+--------+--------+--------+--------+--------+
    // | Public |    Connection ID (64)                                                 | ->
    // |Flags(8)|                                                                       |
    // +--------+--------+--------+--------+--------+--------+--------+--------+--------+
    //
    //      9       10       11        12       13      14       15       16       17
    // +--------+--------+--------+--------+--------+--------+--------+--------+---...--+
    // |      1st QUIC version supported   |     2nd QUIC version supported    |   ...
    // |      by server (32)               |     by server (32)                |
    // +--------+--------+--------+--------+--------+--------+--------+--------+---...--+
    static fromConnectionID(connectionID) {
        return new NegotiationPacket(connectionID, protocol_1.getVersions());
    }
    static fromBuffer(bufv) {
        bufv.walk(1); // flag
        const connectionID = protocol_1.ConnectionID.fromBuffer(bufv);
        const versions = [];
        while (bufv.length > bufv.end) {
            bufv.walk(4);
            const version = bufv.buf.toString('utf8', bufv.start, bufv.end);
            if (!protocol_1.isSupportedVersion(version)) {
                throw new error_1.QuicError('QUIC_INVALID_VERSION');
            }
            versions.push(version);
        }
        return new NegotiationPacket(connectionID, versions);
    }
    constructor(connectionID, versions) {
        super(connectionID, 0b00001001);
        this.versions = versions;
    }
    valueOf() {
        return {
            connectionID: this.connectionID.valueOf(),
            flag: this.flag,
            versions: this.versions,
        };
    }
    byteLen() {
        return 9 + 4 * this.versions.length;
    }
    writeTo(bufv) {
        bufv.walk(1);
        bufv.buf.writeUInt8(this.flag, bufv.start);
        this.connectionID.writeTo(bufv);
        for (const version of this.versions) {
            bufv.walk(4);
            bufv.buf.write(version, bufv.start, 4);
        }
        return bufv;
    }
}
exports.NegotiationPacket = NegotiationPacket;
/** RegularPacket representing a regular Packet. */
class RegularPacket extends Packet {
    // --- Frame Packet
    // +--------+---...---+--------+---...---+
    // | Type   | Payload | Type   | Payload |
    // +--------+---...---+--------+---...---+
    static fromBuffer(bufv, flag, packetSentBy) {
        bufv.walk(1); // flag
        const connectionID = protocol_1.ConnectionID.fromBuffer(bufv);
        let version = '';
        const hasVersion = (flag & 0b1) > 0;
        if (hasVersion) {
            bufv.walk(4);
            version = bufv.buf.toString('utf8', bufv.start, bufv.end);
            if (!protocol_1.isSupportedVersion(version)) {
                throw new error_1.QuicError('QUIC_INVALID_VERSION');
            }
        }
        // Contrary to what the gQUIC wire spec says, the 0x4 bit only indicates the presence of
        // the diversification nonce for packets sent by the server.
        // It doesn't have any meaning when sent by the client.
        let nonce = null;
        if (packetSentBy === protocol_1.SessionType.SERVER && (flag & 0b100) > 0) {
            bufv.walk(32);
            nonce = bufv.buf.slice(bufv.start, bufv.end);
            if (nonce.length !== 32) {
                throw new error_1.QuicError('QUIC_INTERNAL_ERROR');
            }
        }
        const packetNumber = protocol_1.PacketNumber.fromBuffer(bufv, protocol_1.PacketNumber.flagToByteLen((flag & 0b110000) >> 4));
        const packet = new RegularPacket(connectionID, packetNumber, nonce);
        if (version !== '') {
            packet.setVersion(version);
        }
        return packet;
    }
    constructor(connectionID, packetNumber, nonce = null) {
        let flag = 0b00001000;
        flag |= (packetNumber.flagBits() << 4);
        if (nonce != null) {
            flag |= 0x04;
        }
        super(connectionID, flag);
        this.packetNumber = packetNumber;
        this.version = ''; // 4 byte, string
        this.nonce = nonce; // 32 byte, buffer
        this.frames = [];
        this.isRetransmittable = true;
    }
    valueOf() {
        return {
            connectionID: this.connectionID.valueOf(),
            flag: this.flag,
            version: this.version,
            packetNumber: this.packetNumber.valueOf(),
            nonce: this.nonce,
            frames: this.frames.map((val) => val.valueOf()),
        };
    }
    setVersion(version) {
        this.flag |= 0b00000001;
        this.version = version;
    }
    setPacketNumber(packetNumber) {
        this.packetNumber = packetNumber;
        this.flag &= 0b11001111;
        this.flag |= (packetNumber.flagBits() << 4);
    }
    needAck() {
        for (const frame of this.frames) {
            if (frame.isRetransmittable()) {
                return true;
            }
        }
        return false;
    }
    parseFrames(bufv) {
        while (bufv.end < bufv.length) {
            this.addFrames(frame_1.parseFrame(bufv, this.packetNumber));
        }
    }
    addFrames(...frames) {
        this.frames.push(...frames);
        return this;
    }
    headerLen() {
        let len = 9;
        if (this.version !== '') {
            len += 4;
        }
        if (this.nonce != null) {
            len += 32;
        }
        len += this.packetNumber.byteLen();
        return len;
    }
    byteLen() {
        let len = this.headerLen();
        for (const frame of this.frames) {
            len += frame.byteLen();
        }
        return len;
    }
    writeTo(bufv) {
        bufv.walk(1);
        bufv.buf.writeUInt8(this.flag, bufv.start);
        this.connectionID.writeTo(bufv);
        if (this.version !== '') {
            bufv.walk(4);
            bufv.buf.write(this.version, bufv.start, 4);
        }
        if (this.nonce != null) {
            bufv.walk(32);
            this.nonce.copy(bufv.buf, bufv.start, 0, 32);
        }
        this.packetNumber.writeTo(bufv);
        for (const frame of this.frames) {
            frame.writeTo(bufv);
        }
        return bufv;
    }
}
exports.RegularPacket = RegularPacket;
//# sourceMappingURL=packet.js.map