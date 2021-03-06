'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
// **Github:** https://github.com/fidm/quic
//
// **License:** MIT
const util_1 = require("util");
const crypto_1 = require("crypto");
const x509_1 = require("@fidm/x509");
const common_1 = require("./common");
const error_1 = require("./error");
const symbol_1 = require("./symbol");
const QUIC_VERSIONS = ['Q039'];
var SessionType;
(function (SessionType) {
    SessionType[SessionType["SERVER"] = 0] = "SERVER";
    SessionType[SessionType["CLIENT"] = 1] = "CLIENT";
})(SessionType = exports.SessionType || (exports.SessionType = {}));
var FamilyType;
(function (FamilyType) {
    FamilyType["IPv4"] = "IPv4";
    FamilyType["IPv6"] = "IPv6";
})(FamilyType = exports.FamilyType || (exports.FamilyType = {}));
/**
 * Returns supported version.
 */
function getVersion() {
    return QUIC_VERSIONS[0];
}
exports.getVersion = getVersion;
/**
 * Returns supported versions array.
 */
function getVersions() {
    return QUIC_VERSIONS.slice();
}
exports.getVersions = getVersions;
/**
 * Chooses the best version in the overlap of ours and theirs.
 */
function chooseVersion(theirs) {
    for (const v of theirs) {
        if (isSupportedVersion(v)) {
            return v;
        }
    }
    return '';
}
exports.chooseVersion = chooseVersion;
/**
 * Returns true if the server supports this version.
 */
function isSupportedVersion(version) {
    return QUIC_VERSIONS.includes(version);
}
exports.isSupportedVersion = isSupportedVersion;
/** Protocol representing a base protocol. */
class Protocol {
    constructor(val) {
        this[symbol_1.kVal] = val;
    }
    static fromBuffer(_bufv, _len) {
        throw new Error(`class method "fromBuffer" is not implemented`);
    }
    [util_1.inspect.custom](_depth, _options) {
        return `<${this.constructor.name} ${this.toString()}>`;
    }
}
exports.Protocol = Protocol;
const ConnectionIDReg = /^[0-9a-f]{16}$/;
/** ConnectionID representing a connectionID. */
class ConnectionID extends Protocol {
    static fromBuffer(bufv) {
        bufv.mustWalk(8, 'QUIC_INTERNAL_ERROR');
        return new ConnectionID(bufv.buf.toString('hex', bufv.start, bufv.end));
    }
    static random() {
        return new ConnectionID(crypto_1.randomBytes(8).toString('hex'));
    }
    constructor(id) {
        if (!ConnectionIDReg.test(id)) {
            throw new Error('invalid Connection ID');
        }
        super(id);
    }
    /**
     * @return {string} - 16 length hex string
     */
    valueOf() {
        return this[symbol_1.kVal];
    }
    equals(other) {
        return (other instanceof ConnectionID) && this.valueOf() === other.valueOf();
    }
    byteLen() {
        return 8;
    }
    writeTo(bufv) {
        bufv.walk(8);
        bufv.buf.write(this[symbol_1.kVal], bufv.start, 8, 'hex');
        return bufv;
    }
    toString() {
        return this[symbol_1.kVal];
    }
}
exports.ConnectionID = ConnectionID;
/** PacketNumber representing a packetNumber. */
class PacketNumber extends Protocol {
    // The lower 8, 16, 32, or 48 bits of the packet number, based on which
    // FLAG_?BYTE_SEQUENCE_NUMBER flag is set in the public flags.
    // Each Regular Packet (as opposed to the Special public reset and version
    // negotiation packets) is assigned a packet number by the sender.
    // The first packet sent by an endpoint shall have a packet number of 1, and
    // each subsequent packet shall have a packet number one larger than that of the previous packet.
    static flagToByteLen(flagBits) {
        if ((flagBits & 0b11) !== flagBits) {
            throw new Error('invalid flagBits');
        }
        return flagBits > 0 ? (flagBits * 2) : 1;
    }
    static fromBuffer(bufv, len) {
        bufv.mustWalk(len, 'QUIC_INTERNAL_ERROR');
        return new PacketNumber(bufv.buf.readUIntBE(bufv.start, len));
    }
    constructor(val) {
        if (!Number.isInteger(val) || val < 1 || val > 0xffffffffffff) {
            throw new Error(`invalid PacketNumber val ${val}`);
        }
        super(val);
    }
    valueOf() {
        return this[symbol_1.kVal];
    }
    nextNumber() {
        return new PacketNumber(this[symbol_1.kVal] + 1);
    }
    prevNumber() {
        return new PacketNumber(this[symbol_1.kVal] - 1);
    }
    isLimitReached() {
        // If a QUIC endpoint transmits a packet with a packet number of (2^64-1),
        // that packet must include a CONNECTION_CLOSE frame with an error code of QUIC_SEQUENCE_NUMBER_LIMIT_REACHED,
        // and the endpoint must not transmit any additional packets.
        return this[symbol_1.kVal] >= 0xffffffffffff; // but here 2^48
    }
    delta(other) {
        return Math.abs(this.valueOf() - other.valueOf());
    }
    closestTo(a, b) {
        return this.delta(a) < this.delta(b) ? a : b;
    }
    flagBits() {
        const byteLen = this.byteLen();
        if (byteLen === 1) {
            return 0;
        }
        return byteLen / 2;
    }
    equals(other) {
        return (other instanceof PacketNumber) && this.valueOf() === other.valueOf();
    }
    byteLen(isFull = false) {
        if (!isFull) {
            const value = this[symbol_1.kVal];
            if (value <= 0xff) {
                return 1;
            }
            else if (value <= 0xffff) {
                return 2;
            }
            else if (value <= 0xffffffff) {
                return 4;
            }
        }
        return 6;
    }
    writeTo(bufv, isFull = false) {
        const len = isFull ? 6 : this.byteLen();
        bufv.walk(len);
        bufv.buf.writeUIntBE(this[symbol_1.kVal], bufv.start, len);
        return bufv;
    }
    toString() {
        return String(this[symbol_1.kVal]);
    }
}
exports.PacketNumber = PacketNumber;
/** StreamID representing a streamID. */
class StreamID extends Protocol {
    // the Stream-ID must be even if the server initiates the stream, and odd if the client initiates the stream.
    // 0 is not a valid Stream-ID. Stream 1 is reserved for the crypto handshake,
    // which should be the first client-initiated stream.
    /**
     * 2 bits -> 8/8, 16/8, 24/8, 32/8
     */
    static flagToByteLen(flagBits) {
        if ((flagBits & 0b11) !== flagBits) {
            throw new Error('invalid flagBits');
        }
        return flagBits + 1;
    }
    static fromBuffer(bufv, len) {
        bufv.mustWalk(len, 'QUIC_INVALID_STREAM_DATA');
        return new StreamID(bufv.buf.readUIntBE(bufv.start, len));
    }
    constructor(id) {
        // StreamID(0) is used by WINDOW_UPDATE
        if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) {
            throw new Error(`invalid Stream ID ${id}`);
        }
        super(id);
    }
    valueOf() {
        return this[symbol_1.kVal];
    }
    flagBits() {
        return this.byteLen() - 1;
    }
    nextID() {
        const value = this[symbol_1.kVal] + 2;
        return new StreamID(value <= 0xffffffff ? value : (value - 0xffffffff));
    }
    prevID() {
        return new StreamID(this[symbol_1.kVal] - 2);
    }
    equals(other) {
        return (other instanceof StreamID) && this.valueOf() === other.valueOf();
    }
    byteLen(isFull = false) {
        if (!isFull) {
            const value = this[symbol_1.kVal];
            if (value <= 0xff) {
                return 1;
            }
            else if (value <= 0xffff) {
                return 2;
            }
            else if (value <= 0xffffff) {
                return 3;
            }
        }
        return 4;
    }
    writeTo(bufv, isFull = false) {
        const len = isFull ? 4 : this.byteLen();
        bufv.walk(len);
        bufv.buf.writeUIntBE(this[symbol_1.kVal], bufv.start, len);
        return bufv;
    }
    toString() {
        return String(this[symbol_1.kVal]);
    }
}
exports.StreamID = StreamID;
/** Offset representing a data offset. */
class Offset extends Protocol {
    /**
     * 3 bits -> 0, 16/8, 24/8, 32/8, 40/8, 48/8, 56/8, 64/8
     */
    static flagToByteLen(flagBits) {
        if ((flagBits & 0b111) !== flagBits) {
            throw new Error('invalid flagBits');
        }
        return flagBits > 0 ? (flagBits + 1) : 0;
    }
    static fromBuffer(bufv, len) {
        bufv.mustWalk(len, 'QUIC_INTERNAL_ERROR');
        return new Offset(common_1.readUnsafeUInt(bufv.buf, bufv.start, len));
    }
    constructor(offset) {
        if (!Number.isSafeInteger(offset) || offset < 0) {
            throw new Error(`invalid Offset ${offset}`);
        }
        super(offset);
    }
    valueOf() {
        return this[symbol_1.kVal];
    }
    equals(other) {
        return this.valueOf() === other.valueOf();
    }
    gt(other) {
        return this.valueOf() > other.valueOf();
    }
    byteLen(isFull = false) {
        if (!isFull) {
            const value = this[symbol_1.kVal];
            if (value === 0) {
                return 0;
            }
            else if (value <= 0xffff) {
                return 2;
            }
            else if (value <= 0xffffff) {
                return 3;
            }
            else if (value <= 0xffffffff) {
                return 4;
            }
            else if (value <= 0xffffffffff) {
                return 5;
            }
            else if (value <= 0xffffffffffff) {
                return 6;
            }
            return 7; // value should small than 0xffffffffffffff
        }
        return 8;
    }
    /**
     * 0, 16/8, 24/8, 32/8, 40/8, 48/8, 56/8, 64/8 -> 3 bits
     */
    flagBits() {
        const byteLen = this.byteLen();
        if (byteLen === 0) {
            return 0;
        }
        return byteLen > 1 ? (byteLen - 1) : 1;
    }
    writeTo(bufv, isFull = false) {
        const len = isFull ? 8 : this.byteLen();
        bufv.mustWalk(len, 'QUIC_INTERNAL_ERROR');
        common_1.writeUnsafeUInt(bufv.buf, this[symbol_1.kVal], bufv.start, len);
        return bufv;
    }
    toString() {
        return String(this[symbol_1.kVal]);
    }
}
exports.Offset = Offset;
/** SocketAddress representing a socket address. */
class SocketAddress extends Protocol {
    static fromBuffer(bufv) {
        const obj = {
            address: '',
            family: FamilyType.IPv4,
            port: 0,
        };
        bufv.mustWalk(2, 'QUIC_INTERNAL_ERROR');
        const family = bufv.buf.readUInt16BE(bufv.start);
        if (family === 0x02) {
            obj.family = FamilyType.IPv4;
            bufv.mustWalk(4, 'QUIC_INTERNAL_ERROR');
            obj.address = x509_1.bytesToIP(bufv.buf.slice(bufv.start, bufv.end));
            bufv.mustWalk(2, 'QUIC_INTERNAL_ERROR');
            obj.port = bufv.buf.readUInt16BE(bufv.start);
        }
        else if (family === 0x0a) {
            obj.family = FamilyType.IPv6;
            bufv.mustWalk(16, 'QUIC_INTERNAL_ERROR');
            obj.address = x509_1.bytesToIP(bufv.buf.slice(bufv.start, bufv.end));
            bufv.mustWalk(2, 'QUIC_INTERNAL_ERROR');
            obj.port = bufv.buf.readUInt16BE(bufv.start);
        }
        else {
            throw new Error('invalid SocketAddress buffer');
        }
        return new SocketAddress(obj);
    }
    constructor(obj) {
        if (!isAddress(obj)) {
            throw new Error(`invalid Socket Address ${JSON.stringify(obj)}`);
        }
        super(obj.address);
        this.port = obj.port;
        this.family = obj.family;
        this.address = obj.address;
    }
    valueOf() {
        return {
            address: this.address,
            family: this.family,
            port: this.port,
        };
    }
    equals(other) {
        if (!(other instanceof SocketAddress)) {
            return false;
        }
        return this.family === other.family && this.port === other.port && this.address === other.address;
    }
    byteLen() {
        return this.family === FamilyType.IPv4 ? 8 : 20;
    }
    writeTo(bufv) {
        if (this.family === FamilyType.IPv4) {
            bufv.walk(2);
            bufv.buf.writeUInt16BE(0x02, bufv.start);
            const buf = x509_1.bytesFromIP(this.address);
            if (buf == null || buf.length !== 4) {
                throw new Error(`Invalid IPv4 address ${this.address}`);
            }
            bufv.walk(4);
            buf.copy(bufv.buf, bufv.start, 0, 4);
            bufv.walk(2);
            bufv.buf.writeUInt16BE(this.port, bufv.start);
        }
        else {
            bufv.walk(2);
            bufv.buf.writeUInt16BE(0x0a, bufv.start);
            const buf = x509_1.bytesFromIP(this.address);
            if (buf == null || buf.length !== 16) {
                throw new Error(`Invalid IPv6 address ${this.address}`);
            }
            bufv.walk(16);
            buf.copy(bufv.buf, bufv.start, 0, 16);
            bufv.walk(2);
            bufv.buf.writeUInt16BE(this.port, bufv.start);
        }
        return bufv;
    }
    toString() {
        return JSON.stringify(this.valueOf());
    }
}
exports.SocketAddress = SocketAddress;
/** QuicTags representing a QUIC tag. */
class QuicTags extends Protocol {
    static fromBuffer(bufv) {
        bufv.mustWalk(4, 'QUIC_INTERNAL_ERROR');
        const tagName = bufv.buf.readUInt32BE(bufv.start);
        const quicTag = new QuicTags(tagName);
        bufv.mustWalk(4, 'QUIC_INTERNAL_ERROR');
        let count = bufv.buf.readInt16LE(bufv.start); // ignore next 2 bytes
        const baseOffset = bufv.end + 8 * count;
        const v2 = new common_1.Visitor(baseOffset);
        while (count-- > 0) {
            bufv.mustWalk(4, 'QUIC_INTERNAL_ERROR');
            const key = bufv.buf.readInt32BE(bufv.start);
            bufv.mustWalk(4, 'QUIC_INTERNAL_ERROR');
            v2.walk(0);
            v2.end = baseOffset + bufv.buf.readInt32LE(bufv.start);
            if (bufv.length < v2.end) {
                throw new error_1.QuicError('QUIC_INTERNAL_ERROR');
            }
            const val = bufv.buf.slice(v2.start, v2.end);
            quicTag.set(key, val);
        }
        bufv.reset(v2.end, v2.end);
        return quicTag;
    }
    constructor(name) {
        super(name);
        this.name = name;
        this.tags = new Map();
    }
    valueOf() {
        const tags = {};
        for (const [key, value] of this.tags) {
            tags[Tag[key]] = value;
        }
        return {
            name: Tag[this.name],
            tags,
        };
    }
    get size() {
        return this.tags.size;
    }
    [Symbol.iterator]() {
        return this.tags[Symbol.iterator]();
    }
    set(key, val) {
        this.tags.set(key, val);
    }
    get(key) {
        const buf = this.tags.get(key);
        return buf == null ? null : buf;
    }
    has(key) {
        return this.tags.has(key);
    }
    equals(other) {
        if (!(other instanceof QuicTags)) {
            return false;
        }
        if (this.name !== other.name || this.tags.size !== other.tags.size) {
            return false;
        }
        for (const key of this.tags.keys()) {
            const a = this.tags.get(key);
            const b = other.tags.get(key);
            if (a == null || b == null || !a.equals(b)) {
                return false;
            }
        }
        return true;
    }
    byteLen() {
        let byteLen = 8;
        for (const buf of this.tags.values()) {
            byteLen += 8 + buf.length;
        }
        return byteLen;
    }
    writeTo(bufv) {
        bufv.walk(4);
        bufv.buf.writeUInt32BE(this.name, bufv.start);
        bufv.walk(4);
        const size = this.tags.size;
        bufv.buf.writeUInt16LE(size, bufv.start);
        bufv.buf.writeUInt16LE(0, bufv.start + 2);
        let baseOffset = 0;
        const v = new common_1.Visitor(bufv.end + 8 * size);
        const keys = Array.from(this.tags.keys());
        keys.sort((a, b) => a - b);
        for (const key of keys) {
            const val = this.tags.get(key);
            if (val == null) {
                throw new error_1.QuicError('QUIC_INTERNAL_ERROR');
            }
            bufv.walk(4);
            bufv.buf.writeUInt32BE(key, bufv.start);
            bufv.walk(4);
            baseOffset += val.length;
            bufv.buf.writeUInt32LE(baseOffset, bufv.start);
            v.walk(val.length);
            val.copy(bufv.buf, v.start, 0, val.length);
        }
        bufv.reset(v.end, v.end);
        return bufv;
    }
    toString() {
        return JSON.stringify(this.valueOf());
    }
}
exports.QuicTags = QuicTags;
var Tag;
(function (Tag) {
    Tag[Tag["CHLO"] = toTag('C', 'H', 'L', 'O')] = "CHLO";
    Tag[Tag["SHLO"] = toTag('S', 'H', 'L', 'O')] = "SHLO";
    Tag[Tag["SCFG"] = toTag('S', 'C', 'F', 'G')] = "SCFG";
    Tag[Tag["REJ"] = toTag('R', 'E', 'J', '\u{0}')] = "REJ";
    Tag[Tag["SREJ"] = toTag('S', 'R', 'E', 'J')] = "SREJ";
    Tag[Tag["CETV"] = toTag('C', 'E', 'T', 'V')] = "CETV";
    Tag[Tag["PRST"] = toTag('P', 'R', 'S', 'T')] = "PRST";
    Tag[Tag["SCUP"] = toTag('S', 'C', 'U', 'P')] = "SCUP";
    Tag[Tag["ALPN"] = toTag('A', 'L', 'P', 'N')] = "ALPN";
    // Key exchange methods
    Tag[Tag["P256"] = toTag('P', '2', '5', '6')] = "P256";
    Tag[Tag["C255"] = toTag('C', '2', '5', '5')] = "C255";
    // AEAD algorithms
    Tag[Tag["AESG"] = toTag('A', 'E', 'S', 'G')] = "AESG";
    Tag[Tag["CC20"] = toTag('C', 'C', '2', '0')] = "CC20";
    // Socket receive buffer
    Tag[Tag["SRBF"] = toTag('S', 'R', 'B', 'F')] = "SRBF";
    // Congestion control feedback types
    Tag[Tag["QBIC"] = toTag('Q', 'B', 'I', 'C')] = "QBIC";
    // Connection options (COPT) values
    Tag[Tag["AFCW"] = toTag('A', 'F', 'C', 'W')] = "AFCW";
    Tag[Tag["IFW5"] = toTag('I', 'F', 'W', '5')] = "IFW5";
    Tag[Tag["IFW6"] = toTag('I', 'F', 'W', '6')] = "IFW6";
    Tag[Tag["IFW7"] = toTag('I', 'F', 'W', '7')] = "IFW7";
    Tag[Tag["IFW8"] = toTag('I', 'F', 'W', '8')] = "IFW8";
    Tag[Tag["IFW9"] = toTag('I', 'F', 'W', '9')] = "IFW9";
    Tag[Tag["IFWA"] = toTag('I', 'F', 'W', 'a')] = "IFWA";
    Tag[Tag["TBBR"] = toTag('T', 'B', 'B', 'R')] = "TBBR";
    Tag[Tag["1RTT"] = toTag('1', 'R', 'T', 'T')] = "1RTT";
    Tag[Tag["2RTT"] = toTag('2', 'R', 'T', 'T')] = "2RTT";
    Tag[Tag["LRTT"] = toTag('L', 'R', 'T', 'T')] = "LRTT";
    Tag[Tag["BBRR"] = toTag('B', 'B', 'R', 'R')] = "BBRR";
    Tag[Tag["BBR1"] = toTag('B', 'B', 'R', '1')] = "BBR1";
    Tag[Tag["BBR2"] = toTag('B', 'B', 'R', '2')] = "BBR2";
    Tag[Tag["RENO"] = toTag('R', 'E', 'N', 'O')] = "RENO";
    Tag[Tag["TPCC"] = toTag('P', 'C', 'C', '\u{0}')] = "TPCC";
    Tag[Tag["BYTE"] = toTag('B', 'Y', 'T', 'E')] = "BYTE";
    Tag[Tag["IW03"] = toTag('I', 'W', '0', '3')] = "IW03";
    Tag[Tag["IW10"] = toTag('I', 'W', '1', '0')] = "IW10";
    Tag[Tag["IW20"] = toTag('I', 'W', '2', '0')] = "IW20";
    Tag[Tag["IW50"] = toTag('I', 'W', '5', '0')] = "IW50";
    Tag[Tag["1CON"] = toTag('1', 'C', 'O', 'N')] = "1CON";
    Tag[Tag["NTLP"] = toTag('N', 'T', 'L', 'P')] = "NTLP";
    Tag[Tag["NCON"] = toTag('N', 'C', 'O', 'N')] = "NCON";
    Tag[Tag["NRTO"] = toTag('N', 'R', 'T', 'O')] = "NRTO";
    Tag[Tag["UNDO"] = toTag('U', 'N', 'D', 'O')] = "UNDO";
    Tag[Tag["TIME"] = toTag('T', 'I', 'M', 'E')] = "TIME";
    Tag[Tag["ATIM"] = toTag('A', 'T', 'I', 'M')] = "ATIM";
    Tag[Tag["MIN1"] = toTag('M', 'I', 'N', '1')] = "MIN1";
    Tag[Tag["MIN4"] = toTag('M', 'I', 'N', '4')] = "MIN4";
    Tag[Tag["TLPR"] = toTag('T', 'L', 'P', 'R')] = "TLPR";
    Tag[Tag["ACKD"] = toTag('A', 'C', 'K', 'D')] = "ACKD";
    Tag[Tag["AKD2"] = toTag('A', 'K', 'D', '2')] = "AKD2";
    Tag[Tag["AKD3"] = toTag('A', 'K', 'D', '3')] = "AKD3";
    Tag[Tag["AKD4"] = toTag('A', 'K', 'D', '4')] = "AKD4";
    Tag[Tag["AKDU"] = toTag('A', 'K', 'D', 'U')] = "AKDU";
    Tag[Tag["SSLR"] = toTag('S', 'S', 'L', 'R')] = "SSLR";
    Tag[Tag["NPRR"] = toTag('N', 'P', 'R', 'R')] = "NPRR";
    Tag[Tag["5RTO"] = toTag('5', 'R', 'T', 'O')] = "5RTO";
    Tag[Tag["3RTO"] = toTag('3', 'R', 'T', 'O')] = "3RTO";
    Tag[Tag["CTIM"] = toTag('C', 'T', 'I', 'M')] = "CTIM";
    Tag[Tag["DHDT"] = toTag('D', 'H', 'D', 'T')] = "DHDT";
    Tag[Tag["CONH"] = toTag('C', 'O', 'N', 'H')] = "CONH";
    Tag[Tag["LFAK"] = toTag('L', 'F', 'A', 'K')] = "LFAK";
    // TODO(fayang): Remove this connection option in QUIC_VERSION_37, in which
    // MAX_HEADER_LIST_SIZE settings frame should be supported.
    Tag[Tag["SMHL"] = toTag('S', 'M', 'H', 'L')] = "SMHL";
    Tag[Tag["CCVX"] = toTag('C', 'C', 'V', 'X')] = "CCVX";
    Tag[Tag["CBQT"] = toTag('C', 'B', 'Q', 'T')] = "CBQT";
    Tag[Tag["BLMX"] = toTag('B', 'L', 'M', 'X')] = "BLMX";
    Tag[Tag["CPAU"] = toTag('C', 'P', 'A', 'U')] = "CPAU";
    Tag[Tag["NSTP"] = toTag('N', 'S', 'T', 'P')] = "NSTP";
    // Optional support of truncated Connection IDs.  If sent by a peer, the value
    // is the minimum number of bytes allowed for the connection ID sent to the
    // peer.
    Tag[Tag["TCID"] = toTag('T', 'C', 'I', 'D')] = "TCID";
    // Multipath option.
    Tag[Tag["MPTH"] = toTag('M', 'P', 'T', 'H')] = "MPTH";
    Tag[Tag["NCMR"] = toTag('N', 'C', 'M', 'R')] = "NCMR";
    // Enable bandwidth resumption experiment.
    Tag[Tag["BWRE"] = toTag('B', 'W', 'R', 'E')] = "BWRE";
    Tag[Tag["BWMX"] = toTag('B', 'W', 'M', 'X')] = "BWMX";
    Tag[Tag["BWRS"] = toTag('B', 'W', 'R', 'S')] = "BWRS";
    Tag[Tag["BWS2"] = toTag('B', 'W', 'S', '2')] = "BWS2";
    // Enable path MTU discovery experiment.
    Tag[Tag["MTUH"] = toTag('M', 'T', 'U', 'H')] = "MTUH";
    Tag[Tag["MTUL"] = toTag('M', 'T', 'U', 'L')] = "MTUL";
    // Tags for async signing experiments
    Tag[Tag["ASYN"] = toTag('A', 'S', 'Y', 'N')] = "ASYN";
    Tag[Tag["SYNC"] = toTag('S', 'Y', 'N', 'C')] = "SYNC";
    Tag[Tag["FHL2"] = toTag('F', 'H', 'L', '2')] = "FHL2";
    // Proof types (i.e. certificate types)
    // NOTE: although it would be silly to do so, specifying both kX509 and kX59R
    // is allowed and is equivalent to specifying only kX509.
    Tag[Tag["X509"] = toTag('X', '5', '0', '9')] = "X509";
    Tag[Tag["X59R"] = toTag('X', '5', '9', 'R')] = "X59R";
    Tag[Tag["CHID"] = toTag('C', 'H', 'I', 'D')] = "CHID";
    // Client hello tags
    Tag[Tag["VER"] = toTag('V', 'E', 'R', '\u{0}')] = "VER";
    Tag[Tag["NONC"] = toTag('N', 'O', 'N', 'C')] = "NONC";
    Tag[Tag["NONP"] = toTag('N', 'O', 'N', 'P')] = "NONP";
    Tag[Tag["KEXS"] = toTag('K', 'E', 'X', 'S')] = "KEXS";
    Tag[Tag["AEAD"] = toTag('A', 'E', 'A', 'D')] = "AEAD";
    Tag[Tag["COPT"] = toTag('C', 'O', 'P', 'T')] = "COPT";
    Tag[Tag["CLOP"] = toTag('C', 'L', 'O', 'P')] = "CLOP";
    Tag[Tag["ICSL"] = toTag('I', 'C', 'S', 'L')] = "ICSL";
    Tag[Tag["SCLS"] = toTag('S', 'C', 'L', 'S')] = "SCLS";
    Tag[Tag["MSPC"] = toTag('M', 'S', 'P', 'C')] = "MSPC";
    Tag[Tag["MIDS"] = toTag('M', 'I', 'D', 'S')] = "MIDS";
    Tag[Tag["IRTT"] = toTag('I', 'R', 'T', 'T')] = "IRTT";
    Tag[Tag["SWND"] = toTag('S', 'W', 'N', 'D')] = "SWND";
    Tag[Tag["SNI"] = toTag('S', 'N', 'I', '\u{0}')] = "SNI";
    Tag[Tag["PUBS"] = toTag('P', 'U', 'B', 'S')] = "PUBS";
    Tag[Tag["SCID"] = toTag('S', 'C', 'I', 'D')] = "SCID";
    Tag[Tag["ORBT"] = toTag('O', 'B', 'I', 'T')] = "ORBT";
    Tag[Tag["PDMD"] = toTag('P', 'D', 'M', 'D')] = "PDMD";
    Tag[Tag["PROF"] = toTag('P', 'R', 'O', 'F')] = "PROF";
    Tag[Tag["CCS"] = toTag('C', 'C', 'S', '\u{0}')] = "CCS";
    Tag[Tag["CCRT"] = toTag('C', 'C', 'R', 'T')] = "CCRT";
    Tag[Tag["EXPY"] = toTag('E', 'X', 'P', 'Y')] = "EXPY";
    Tag[Tag["STTL"] = toTag('S', 'T', 'T', 'L')] = "STTL";
    Tag[Tag["SFCW"] = toTag('S', 'F', 'C', 'W')] = "SFCW";
    Tag[Tag["CFCW"] = toTag('C', 'F', 'C', 'W')] = "CFCW";
    Tag[Tag["UAID"] = toTag('U', 'A', 'I', 'D')] = "UAID";
    Tag[Tag["XLCT"] = toTag('X', 'L', 'C', 'T')] = "XLCT";
    Tag[Tag["TBKP"] = toTag('T', 'B', 'K', 'P')] = "TBKP";
    // Token Binding tags
    Tag[Tag["TB10"] = toTag('T', 'B', '1', '0')] = "TB10";
    // Rejection tags
    Tag[Tag["RREJ"] = toTag('R', 'R', 'E', 'J')] = "RREJ";
    // Stateless Reject tags
    Tag[Tag["RCID"] = toTag('R', 'C', 'I', 'D')] = "RCID";
    // Server hello tags
    Tag[Tag["CADR"] = toTag('C', 'A', 'D', 'R')] = "CADR";
    Tag[Tag["ASAD"] = toTag('A', 'S', 'A', 'D')] = "ASAD";
    // CETV tags
    Tag[Tag["CIDK"] = toTag('C', 'I', 'D', 'K')] = "CIDK";
    Tag[Tag["CIDS"] = toTag('C', 'I', 'D', 'S')] = "CIDS";
    // Public reset tags
    Tag[Tag["RNON"] = toTag('R', 'N', 'O', 'N')] = "RNON";
    Tag[Tag["RSEQ"] = toTag('R', 'S', 'E', 'Q')] = "RSEQ";
    // Universal tags
    Tag[Tag["PAD"] = toTag('P', 'A', 'D', '\u{0}')] = "PAD";
    // Server push tags
    Tag[Tag["SPSH"] = toTag('S', 'P', 'S', 'H')] = "SPSH";
    // clang-format on
    // These tags have a special form so that they appear either at the beginning
    // or the end of a handshake message. Since handshake messages are sorted by
    // tag value, the tags with 0 at the end will sort first and those with 255 at
    // the end will sort last.
    //
    // The certificate chain should have a tag that will cause it to be sorted at
    // the end of any handshake messages because it's likely to be large and the
    // client might be able to get everything that it needs from the small values at
    // the beginning.
    //
    // Likewise tags with random values should be towards the beginning of the
    // message because the server mightn't hold state for a rejected client hello
    // and therefore the client may have issues reassembling the rejection message
    // in the event that it sent two client hellos.
    Tag[Tag["SNO"] = toTag('S', 'N', 'O', '\u{0}')] = "SNO";
    Tag[Tag["STK"] = toTag('S', 'T', 'K', '\u{0}')] = "STK";
    Tag[Tag["CRT"] = toTag('C', 'R', 'T', '\u{ff}')] = "CRT";
    Tag[Tag["CSCT"] = toTag('C', 'S', 'C', 'T')] = "CSCT";
})(Tag = exports.Tag || (exports.Tag = {}));
function toTag(a, b, c, d) {
    return a.charCodeAt(0) * (0xffffff + 1) + b.charCodeAt(0) * (0xffff + 1) +
        c.charCodeAt(0) * (0xff + 1) + d.charCodeAt(0);
}
function isAddress(address) {
    return address != null && address.port >= 0 && Number.isInteger(address.port) &&
        typeof address.address === 'string' &&
        (address.family === FamilyType.IPv4 || address.family === FamilyType.IPv6);
}
//# sourceMappingURL=protocol.js.map