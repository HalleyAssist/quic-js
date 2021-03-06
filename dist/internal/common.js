'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
// **Github:** https://github.com/fidm/quic
//
// **License:** MIT
const util_1 = require("util");
const dns_1 = require("dns");
exports.dnsLookup = util_1.promisify(dns_1.lookup);
class Visitor {
    constructor(start = 0, end = 0) {
        this.start = start;
        this.end = end > start ? end : start;
    }
    reset(start = 0, end = 0) {
        this.start = start;
        if (end >= this.start) {
            this.end = end;
        }
        else if (this.end < this.start) {
            this.end = this.start;
        }
        return this;
    }
    walk(steps) {
        this.start = this.end;
        this.end += steps;
        return this;
    }
}
exports.Visitor = Visitor;
class BufferVisitor extends Visitor {
    constructor(buf, start = 0, end = 0) {
        super(start, end);
        this.buf = buf;
    }
    get length() {
        return this.buf.length;
    }
    mustHas(steps, message = 'QUIC_INTERNAL_ERROR') {
        const requested = this.end + steps;
        if (requested > this.buf.length) {
            const error = new Error(message);
            error.available = this.buf.length;
            error.requested = requested;
            throw error;
        }
        this.walk(0);
    }
    mustWalk(steps, message) {
        this.mustHas(steps, message);
        this.walk(steps);
    }
}
exports.BufferVisitor = BufferVisitor;
function toBuffer(obj) {
    const bufv = obj.writeTo(new BufferVisitor(Buffer.alloc(obj.byteLen())));
    return bufv.buf;
}
exports.toBuffer = toBuffer;
// We define an unsigned 16-bit floating point value, inspired by IEEE floats
// (http://en.wikipedia.org/wiki/Half_precision_floating-point_format),
// with 5-bit exponent (bias 1), 11-bit mantissa (effective 12 with hidden
// bit) and denormals, but without signs, transfinites or fractions. Wire format
// 16 bits (little-endian byte order) are split into exponent (high 5) and
// mantissa (low 11)
// https://github.com/google/proto-quic/blob/master/src/net/quic/core/quic_protocol.h#L197
const Float16ExponentBits = 5;
const Float16MantissaBits = 16 - Float16ExponentBits; // 11
const Float16MantissaEffectiveBits = Float16MantissaBits + 1; // 12
const Float16MantissaEffectiveValue = 1 << Float16MantissaEffectiveBits;
// Float16MaxValue === readUFloat16(<Buffer 0xff 0xff>)
exports.Float16MaxValue = 0x3FFC0000000;
function readUFloat16(buf, offset = 0) {
    let value = buf.readUInt16BE(offset);
    if (value < Float16MantissaEffectiveValue) {
        return value;
    }
    let exponent = value >> Float16MantissaBits;
    --exponent;
    value -= exponent << Float16MantissaBits;
    // we can only use binary bitwise operators in 32 bits
    const res = value * Math.pow(2, exponent);
    return res < exports.Float16MaxValue ? res : exports.Float16MaxValue;
}
exports.readUFloat16 = readUFloat16;
function writeUFloat16(buf, value, offset) {
    let res = 0;
    if (value < Float16MantissaEffectiveValue) {
        res = value;
    }
    else if (value >= exports.Float16MaxValue) {
        res = 0xffff;
    }
    else {
        let exponent = 0;
        for (let i = 16; i >= 1; i /= 2) {
            if (value >= (1 << (Float16MantissaBits + i))) {
                exponent += i;
                value /= Math.pow(2, i);
            }
        }
        res = Math.floor(value) + (exponent << Float16MantissaBits);
    }
    buf.writeUInt16BE(res, offset);
    return buf;
}
exports.writeUFloat16 = writeUFloat16;
const unsafeUIntRadix = 0xffffffffffff + 1;
function readUnsafeUInt(buf, offset, len) {
    let val = 0;
    if (len > 6) {
        val = buf.readUIntBE(offset + len - 6, 6);
        const high = buf.readUIntBE(offset, len - 6);
        if (high > 0) {
            val += high * unsafeUIntRadix;
        }
    }
    else if (len > 0) {
        val = buf.readUIntBE(offset, len);
    }
    return val;
}
exports.readUnsafeUInt = readUnsafeUInt;
function writeUnsafeUInt(buf, val, offset, len) {
    if (len > 6) {
        if (val <= 0xffffffffffff) {
            buf.writeUIntBE(val, offset + len - 6, 6);
            buf.writeUIntBE(0, offset, len - 6); // clear cached bits
        }
        else {
            const high = Math.floor(val / unsafeUIntRadix);
            buf.writeUIntBE(val - high * unsafeUIntRadix, offset + len - 6, 6);
            buf.writeUIntBE(high, offset, len - 6);
        }
    }
    else if (len > 0) {
        buf.writeUIntBE(val, offset, len);
    }
    return buf;
}
exports.writeUnsafeUInt = writeUnsafeUInt;
class Queue {
    constructor() {
        this.tail = [];
        this.head = [];
        this.offset = 0;
        this.hLength = 0;
    }
    get length() {
        return this.hLength + this.tail.length - this.offset;
    }
    first() {
        return this.hLength === this.offset ? this.tail[0] : this.head[this.offset];
    }
    push(item) {
        this.tail.push(item);
    }
    pop() {
        if (this.tail.length > 0) {
            return this.tail.pop();
        }
        if (this.hLength === 0) {
            return;
        }
        this.hLength--;
        return this.head.pop();
    }
    unshift(item) {
        if (this.offset === 0) {
            this.hLength++;
            this.head.unshift(item);
        }
        else {
            this.offset--;
            this.head[this.offset] = item;
        }
    }
    shift() {
        if (this.offset === this.hLength) {
            if (this.tail.length === 0) {
                return;
            }
            const tmp = this.head;
            tmp.length = 0;
            this.head = this.tail;
            this.tail = tmp;
            this.offset = 0;
            this.hLength = this.head.length;
        }
        return this.head[this.offset++];
    }
    toArray() {
        const arr = [];
        if (this.offset === this.hLength) {
            for (const item of this.tail) {
                arr.push(item);
            }
        }
        else {
            for (let i = this.offset, l = this.head.length; i < l; i++) {
                arr.push(this.head[i]);
            }
        }
        return arr;
    }
    reset() {
        this.offset = 0;
        this.hLength = 0;
        this.tail.length = 0;
        this.head.length = 0;
    }
    migrateTo(queue) {
        let i = this.offset;
        const len = this.tail.length;
        while (i < this.hLength) {
            queue.push(this.head[i++]);
        }
        i = 0;
        while (i < len) {
            queue.push(this.tail[i++]);
        }
        this.offset = this.hLength = this.head.length = this.tail.length = 0;
        return queue;
    }
}
exports.Queue = Queue;
//# sourceMappingURL=common.js.map