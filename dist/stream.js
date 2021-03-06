'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
// **Github:** https://github.com/fidm/quic
//
// **License:** MIT
const util_1 = require("util");
const stream_1 = require("stream");
const error_1 = require("./internal/error");
const constant_1 = require("./internal/constant");
const protocol_1 = require("./internal/protocol");
const frame_1 = require("./internal/frame");
const flowcontrol_1 = require("./internal/flowcontrol");
const common_1 = require("./internal/common");
const symbol_1 = require("./internal/symbol");
const debug = util_1.debuglog('quic:stream');
class Stream extends stream_1.Duplex {
    constructor(streamID, session, options) {
        options.allowHalfOpen = true;
        options.objectMode = false;
        super(options);
        this[symbol_1.kID] = streamID;
        this[symbol_1.kSession] = session;
        this[symbol_1.kState] = new StreamState();
        this[symbol_1.kFC] = session.isClient ? // TODO: small window will make "packets loss" test failure
            new flowcontrol_1.StreamFlowController(constant_1.ReceiveStreamWindow, constant_1.DefaultMaxReceiveStreamWindowClient, session[symbol_1.kFC]) :
            new flowcontrol_1.StreamFlowController(constant_1.ReceiveStreamWindow, constant_1.DefaultMaxReceiveStreamWindowServer, session[symbol_1.kFC]);
        this.once('close', () => this[symbol_1.kState].lastActivityTime = Date.now());
        debug(`session %s - new stream: %d`, session.id, streamID.valueOf());
    }
    // The socket owned by this session
    get id() {
        return this[symbol_1.kID].valueOf();
    }
    get aborted() {
        return this[symbol_1.kState].aborted;
    }
    get destroyed() {
        return this[symbol_1.kState].destroyed;
    }
    get bytesRead() {
        return this[symbol_1.kFC].consumedOffset;
    }
    get bytesWritten() {
        return this[symbol_1.kFC].writtenOffset;
    }
    get closing() {
        return this[symbol_1.kState].localFIN;
    }
    // close closes the stream with an error.
    close(err, callback) {
        console.log("ee - %s", err)
        if (typeof err == "function") {
            callback = err;
            err = 0;
        }
        this[symbol_1.kState].localFIN = true;
        const offset = new protocol_1.Offset(this[symbol_1.kFC].writtenOffset);
        const rstStreamFrame = new frame_1.RstStreamFrame(this[symbol_1.kID], offset, error_1.StreamError.fromError(err));
        debug(`stream %s - close stream, offset: %d, error: %j`, this.id, offset.valueOf(), err);
        return new Promise((resolve) => {
            this[symbol_1.kSession]._sendFrame(rstStreamFrame, (e) => {
                if (e != null) {
                    this.destroy(e);
                }
                resolve();
                if (callback)
                    callback();
            });
        });
    }
    _write(chunk, encoding, callback) {
        if (this[symbol_1.kState].localFIN) {
            return callback(new error_1.StreamError('QUIC_RST_ACKNOWLEDGEMENT'));
        }
        if (!(chunk instanceof Buffer)) {
            chunk = Buffer.from(chunk, encoding);
        }
        if (chunk.length === 0) {
            return callback(null);
        }
        this[symbol_1.kState].outgoingChunksList.push(chunk, callback);
        this._tryFlushCallbacks();
    }
    _writev(chunks, callback) {
        if (this[symbol_1.kState].localFIN) {
            return callback(new error_1.StreamError('QUIC_RST_ACKNOWLEDGEMENT'));
        }
        let len = 0;
        const list = [];
        for (const item of chunks) {
            // { chunk: ..., encoding: ... }
            let chunk = item.chunk;
            if (!(chunk instanceof Buffer)) {
                chunk = Buffer.from(chunk, item.encoding);
            }
            len += chunk.length;
            list.push(chunk);
        }
        if (len === 0) {
            return callback(null);
        }
        this[symbol_1.kState].outgoingChunksList.push(Buffer.concat(list, len), callback);
        this._tryFlushCallbacks();
    }
    _final(callback) {
        this[symbol_1.kState].outgoingChunksList.push(null, callback);
        this._tryFlushCallbacks();
    }
    _read(size = 0) {
        let data = this[symbol_1.kState].incomingSequencer.read();
        while (data != null) {
            if (this.push(data) && size > data.length) {
                size -= data.length;
                data = this[symbol_1.kState].incomingSequencer.read();
                continue;
            }
            break;
        }
        this[symbol_1.kFC].updateConsumedOffset(this[symbol_1.kState].incomingSequencer.consumedOffset);
        if (!this[symbol_1.kState].remoteFIN) {
            process.nextTick(() => this._trySendUpdateWindow());
        }
        if (!this[symbol_1.kState].ended && this[symbol_1.kState].incomingSequencer.isFIN()) {
            this[symbol_1.kState].ended = true;
            this.push(null);
        }
    }
    _destroy(err, callback) {
        debug(`stream %s - stream destroyed, error: %j`, this.id, err);
        this[symbol_1.kSession]._stateDecreaseStreamCount();
        const state = this[symbol_1.kState];
        state.localFIN = true;
        state.remoteFIN = true;
        state.aborted = true;
        state.destroyed = true;
        state.finished = true;
        state.incomingSequencer.reset();
        state.outgoingChunksList.reset();
        err = error_1.StreamError.checkAny(err);
        if (err != null && err.isNoError) {
            err = null;
        }
        callback(err);
    }
    _sendBlockFrame() {
        this[symbol_1.kSession]._sendFrame(new frame_1.BlockedFrame(this[symbol_1.kID]));
    }
    _trySendUpdateWindow() {
        if (this[symbol_1.kFC].shouldUpdateWindow()) {
            const offset = this[symbol_1.kFC].updateWindowOffset(this[symbol_1.kSession][symbol_1.kRTT].msRTT);
            this[symbol_1.kSession]._sendWindowUpdate(new protocol_1.Offset(offset), this[symbol_1.kID]);
        }
    }
    _handleFrame(frame, rcvTime) {
        this[symbol_1.kState].lastActivityTime = rcvTime;
        const offset = frame.offset.valueOf();
        const byteLen = frame.data == null ? 0 : frame.data.length;
        debug(`stream %s - received StreamFrame, offset: %d, data size: %d, isFIN: %s`, this.id, offset, byteLen, frame.isFIN);
        this[symbol_1.kFC].updateHighestReceived(offset + byteLen);
        if (this[symbol_1.kFC].isBlocked()) {
            this.emit('error', new Error('The window of byte offset overflowed'));
            this.close(error_1.StreamError.fromError(error_1.StreamError.QUIC_ERROR_PROCESSING_STREAM));
            return;
        }
        if (frame.isFIN) {
            this[symbol_1.kState].remoteFIN = true;
            this[symbol_1.kState].incomingSequencer.setFinalOffset(offset + byteLen);
        }
        if (frame.data != null) {
            if (this[symbol_1.kState].incomingSequencer.hasOffset(offset)) {
                return; // duplicated frame
            }
            this[symbol_1.kState].incomingSequencer.push(frame);
        }
        this._read();
        if (this[symbol_1.kState].incomingSequencer.byteLen > constant_1.MaxStreamReadCacheSize) {
            this.emit('error', new Error('Too large caching, stream data maybe lost'));
            this.destroy(error_1.StreamError.fromError(error_1.StreamError.QUIC_ERROR_PROCESSING_STREAM));
        }
    }
    _handleRstFrame(frame, rcvTime) {
        this[symbol_1.kState].lastActivityTime = rcvTime;
        this[symbol_1.kState].remoteFIN = true;
        this[symbol_1.kState].incomingSequencer.setFinalOffset(frame.offset.valueOf());
        debug(`stream %s - received RstStreamFrame, offset: %d, error: %j`, this.id, frame.offset.valueOf(), frame.error);
        if (this[symbol_1.kState].localFIN) {
            this.destroy(frame.error);
        }
        else {
            this.emit('error', frame.error);
            this.close(error_1.StreamError.fromError(error_1.StreamError.QUIC_RST_ACKNOWLEDGEMENT));
        }
        return;
    }
    _tryFlushCallbacks() {
        const entry = this[symbol_1.kState].outgoingChunksList.first();
        if (entry == null || this[symbol_1.kState].flushing) {
            return;
        }
        if (entry.data != null && !this._isRemoteWriteable(this[symbol_1.kSession]._stateMaxPacketSize)) {
            return;
        }
        const callback = entry.callback;
        this[symbol_1.kState].flushing = true;
        this._flushData(entry.data, (err) => {
            this[symbol_1.kState].flushing = false;
            if (entry.checkConsumed()) {
                this[symbol_1.kState].outgoingChunksList.shift();
                callback(err);
            }
            if (err == null && this[symbol_1.kState].outgoingChunksList.pendingCb > 0) {
                return this._tryFlushCallbacks();
            }
        });
    }
    _isRemoteWriteable(byteLen) {
        if (this[symbol_1.kFC].willBlocked(byteLen)) {
            // should wait for WINDOW_UPDATE
            debug(`stream %s - wait for WINDOW_UPDATE, writtenOffset: %d, maxSendOffset: %d, to write size: %d`, this.id, this[symbol_1.kFC].writtenOffset, this[symbol_1.kFC].maxSendOffset, byteLen);
            this._sendBlockFrame();
            return false;
        }
        return true;
    }
    _flushData(bufv, callback) {
        let byteLen = 0; // bytes to write
        let nextByteLen = 0; // bytes for next write
        const offet = new protocol_1.Offset(this[symbol_1.kFC].writtenOffset);
        const streamFrame = new frame_1.StreamFrame(this[symbol_1.kID], offet, bufv == null);
        const packet = this[symbol_1.kSession]._newRegularPacket();
        if (bufv != null) {
            byteLen = Math.min(bufv.length - bufv.end, this[symbol_1.kSession]._stateMaxPacketSize - packet.headerLen() - streamFrame.headerLen(true));
            bufv.walk(byteLen);
            nextByteLen = Math.min(byteLen, bufv.length - bufv.end);
            streamFrame.setData(bufv.buf.slice(bufv.start, bufv.end));
            this[symbol_1.kFC].updateWrittenOffset(byteLen);
        }
        if (streamFrame.isFIN) {
            this[symbol_1.kState].localFIN = true;
        }
        debug(`stream %s - write streamFrame, isFIN: %s, offset: %d, data size: %d`, this.id, streamFrame.isFIN, streamFrame.offset.valueOf(), byteLen);
        packet.addFrames(streamFrame);
        packet.isRetransmittable = true;
        this[symbol_1.kSession]._sendPacket(packet, (err) => {
            // Packet Number length maybe increase 1 byte
            if (err != null || nextByteLen === 0 || !this._isRemoteWriteable(nextByteLen + 1)) {
                return callback(err);
            }
            this._flushData(bufv, callback);
        });
    }
}
exports.Stream = Stream;
class StreamState {
    constructor() {
        this.localFIN = false; // local endpoint will not send data
        this.remoteFIN = false; // remote endpoint should not send data
        this.flushing = false;
        this.ended = false;
        this.aborted = false;
        this.destroyed = false;
        this.finished = false;
        this.startTime = Date.now();
        this.incomingSequencer = new StreamSequencer();
        this.outgoingChunksList = new StreamDataList();
    }
}
class StreamDataEntry {
    constructor(callback, buf) {
        this.callback = callback;
        this.next = null;
        this.data = buf == null ? null : new common_1.BufferVisitor(buf);
    }
    get byteLen() {
        return this.data == null ? 0 : this.data.length;
    }
    checkConsumed() {
        return this.data == null || this.data.end === this.data.length;
    }
}
class StreamDataList {
    constructor() {
        this.head = null;
        this.tail = null;
        this.pendingCb = 0;
        this.byteLen = 0;
    }
    reset() {
        this.head = null;
        this.tail = null;
        this.pendingCb = 0;
        this.byteLen = 0;
    }
    push(buf, callback) {
        const entry = new StreamDataEntry(callback, buf);
        if (this.tail != null) {
            this.tail.next = entry;
        }
        else {
            this.head = entry;
        }
        this.tail = entry;
        this.pendingCb += 1;
        this.byteLen += entry.byteLen;
    }
    first() {
        return this.head;
    }
    shift() {
        if (this.head == null) {
            return null;
        }
        const entry = this.head;
        if (this.pendingCb === 1) {
            this.head = this.tail = null;
        }
        else {
            this.head = this.head.next;
        }
        this.pendingCb -= 1;
        this.byteLen -= entry.byteLen;
        return entry;
    }
}
class StreamFrameEntry {
    constructor(frame, entry) {
        this.data = frame.data;
        this.offset = frame.offset.valueOf();
        this.next = entry;
    }
}
// sequencer
class StreamSequencer {
    constructor() {
        this.head = null;
        this.byteLen = 0;
        this.consumedOffset = 0;
        this.finalOffset = -1;
        this.pendingOffsets = new Set();
    }
    hasOffset(offset) {
        if (offset < this.consumedOffset) {
            return true;
        }
        return this.pendingOffsets.has(offset);
    }
    reset() {
        this.head = null;
        this.byteLen = 0;
        this.consumedOffset = 0;
        this.finalOffset = -1;
        this.pendingOffsets.clear();
    }
    setFinalOffset(offset) {
        this.finalOffset = offset;
    }
    isFIN() {
        return this.consumedOffset === this.finalOffset;
    }
    /**
     * @param {StreamFrame}
     */
    push(frame) {
        const entry = new StreamFrameEntry(frame, null);
        const offset = entry.offset;
        this.pendingOffsets.add(offset);
        if (entry.data != null) {
            this.byteLen += entry.data.length;
        }
        if (this.head == null) {
            this.head = entry;
        }
        else if (this.head.offset > offset) {
            entry.next = this.head;
            this.head = entry;
        }
        else {
            let prev = this.head;
            while (true) {
                if (prev.next == null) {
                    prev.next = entry;
                    break;
                }
                if (prev.next.offset > offset) {
                    entry.next = prev.next;
                    prev.next = entry;
                    break;
                }
                prev = prev.next;
            }
        }
    }
    read() {
        let data = null;
        if (this.head != null && this.consumedOffset === this.head.offset) {
            data = this.head.data;
            if (data != null) {
                this.pendingOffsets.delete(this.consumedOffset);
                this.byteLen -= data.length;
                this.consumedOffset += data.length;
            }
            this.head = this.head.next;
        }
        return data;
    }
}
//# sourceMappingURL=stream.js.map
