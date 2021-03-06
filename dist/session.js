'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
// **Github:** https://github.com/fidm/quic
//
// **License:** MIT
const util_1 = require("util");
const events_1 = require("events");
const constant_1 = require("./internal/constant");
const protocol_1 = require("./internal/protocol");
const symbol_1 = require("./internal/symbol");
const frame_1 = require("./internal/frame");
const packet_1 = require("./internal/packet");
const error_1 = require("./internal/error");
const flowcontrol_1 = require("./internal/flowcontrol");
const congestion_1 = require("./internal/congestion");
const common_1 = require("./internal/common");
const stream_1 = require("./stream");
const handshake_1 = require("./handshake");
const debug = util_1.debuglog('quic:session');
//
// *************** Session ***************
//
class Session extends events_1.EventEmitter {
    constructor(id, type) {
        super();
        this[symbol_1.kID] = id;
        this[symbol_1.kType] = type;
        this[symbol_1.kStreams] = new Map();
        this[symbol_1.kNextStreamID] = new protocol_1.StreamID(type === protocol_1.SessionType.SERVER ? 2 : 1);
        this[symbol_1.kState] = new SessionState();
        this[symbol_1.kACKHandler] = new ACKHandler();
        this[symbol_1.kHS] = new handshake_1.HandShake(this); // will be overwrite
        this[symbol_1.kSocket] = null;
        this[symbol_1.kVersion] = '';
        this[symbol_1.kIntervalCheck] = null;
        this[symbol_1.kNextPacketNumber] = new protocol_1.PacketNumber(1);
        this[symbol_1.kUnackedPackets] = new common_1.Queue(); // up to 1000
        this[symbol_1.kRTT] = new congestion_1.RTTStats();
        this[symbol_1.kFC] = this.isClient ? // TODO
            new flowcontrol_1.ConnectionFlowController(constant_1.ReceiveConnectionWindow, constant_1.DefaultMaxReceiveConnectionWindowClient) :
            new flowcontrol_1.ConnectionFlowController(constant_1.ReceiveConnectionWindow, constant_1.DefaultMaxReceiveConnectionWindowServer);
        this.on("error", (err) => debug("Unhandled error: %s", err));
    }
    get id() {
        return this[symbol_1.kID].valueOf();
    }
    get version() {
        return this[symbol_1.kVersion];
    }
    get isClient() {
        return this[symbol_1.kType] === protocol_1.SessionType.CLIENT;
    }
    get destroyed() {
        return this[symbol_1.kState].destroyed;
    }
    get localAddr() {
        return {
            address: this[symbol_1.kState].localAddress,
            family: this[symbol_1.kState].localFamily,
            port: this[symbol_1.kState].localPort,
            socketAddress: this[symbol_1.kState].localAddr,
        };
    }
    get remoteAddr() {
        return {
            address: this[symbol_1.kState].remoteAddress,
            family: this[symbol_1.kState].remoteFamily,
            port: this[symbol_1.kState].remotePort,
            socketAddress: this[symbol_1.kState].remoteAddr,
        };
    }
    get _stateMaxPacketSize() {
        return this[symbol_1.kState].maxPacketSize;
    }
    get timeout() {
        return this[symbol_1.kState].idleTimeout;
    }
    get lastNetworkActivityTime() {
        return this[symbol_1.kState].lastNetworkActivityTime;
    }
    set timeout(msecs) {
        this[symbol_1.kState].idleTimeout = msecs;
    }
    _stateDecreaseStreamCount() {
        this[symbol_1.kState].liveStreamCount -= 1;
    }
    _newRegularPacket() {
        const packetNumber = this[symbol_1.kNextPacketNumber];
        this[symbol_1.kNextPacketNumber] = packetNumber.nextNumber();
        return new packet_1.RegularPacket(this[symbol_1.kID], packetNumber);
    }
    _sendFrame(frame, callback) {
        const regularPacket = this._newRegularPacket();
        regularPacket.addFrames(frame);
        regularPacket.isRetransmittable = frame.isRetransmittable();
        this._sendPacket(regularPacket, callback);
    }
    _sendStopWaitingFrame(leastUnacked) {
        const regularPacket = this._newRegularPacket();
        const frame = new frame_1.StopWaitingFrame(regularPacket.packetNumber, leastUnacked);
        regularPacket.addFrames(frame);
        regularPacket.isRetransmittable = false;
        debug(`%s session %s - write StopWaitingFrame, packetNumber: %d, leastUnacked: %d`, protocol_1.SessionType[this[symbol_1.kType]], this.id, frame.packetNumber.valueOf(), leastUnacked);
        this._sendPacket(regularPacket);
    }
    _retransmit(frame, rcvTime) {
        const unackedPackets = this[symbol_1.kUnackedPackets];
        debug(`%s session %s - start retransmit, count: %d, ackFrame: %j`, protocol_1.SessionType[this[symbol_1.kType]], this.id, unackedPackets.length, frame.valueOf());
        let count = 0;
        let packet = unackedPackets.first();
        while (packet != null) {
            const packetNumber = packet.packetNumber.valueOf();
            if (packetNumber > frame.largestAcked) {
                break; // wait for newest ack
            }
            else if (packetNumber === frame.largestAcked) {
                this[symbol_1.kRTT].updateRTT(packet.sentTime, rcvTime, frame.delayTime);
            }
            if (frame.acksPacket(packetNumber)) {
                unackedPackets.shift();
                packet = unackedPackets.first();
                continue;
            }
            unackedPackets.shift();
            packet.setPacketNumber(this[symbol_1.kNextPacketNumber]);
            this[symbol_1.kNextPacketNumber] = packet.packetNumber.nextNumber();
            this._sendPacket(packet);
            count += 1;
            packet = unackedPackets.first();
        }
        debug(`%s session %s - finish retransmit, count: %d`, protocol_1.SessionType[this[symbol_1.kType]], this.id, count);
        return count;
    }
    _sendPacket(packet, callback) {
        const socket = this[symbol_1.kSocket];
        if (callback == null) {
            callback = (err) => {
                if (err != null) {
                    this.destroy(err);
                }
            };
        }
        if (socket == null) {
            return callback(error_1.QuicError.fromError(error_1.QuicError.QUIC_PACKET_WRITE_ERROR));
        }
        if (socket[symbol_1.kState].destroyed) {
            return callback(error_1.QuicError.fromError(error_1.QuicError.QUIC_PACKET_WRITE_ERROR));
        }
        if (packet.isRegular()) {
            const _packet = packet;
            if (this.isClient && !this[symbol_1.kState].versionNegotiated) {
                _packet.setVersion(this[symbol_1.kVersion]);
            }
            if (_packet.isRetransmittable) {
                this[symbol_1.kUnackedPackets].push(packet);
                if (this[symbol_1.kUnackedPackets].length > 4096) {
                    return callback(error_1.QuicError.fromError(error_1.QuicError.QUIC_TOO_MANY_OUTSTANDING_SENT_PACKETS));
                }
            }
            debug(`%s session %s - write RegularPacket, packetNumber: %d, frames: %j`, protocol_1.SessionType[this[symbol_1.kType]], this.id, _packet.packetNumber.valueOf(), _packet.frames.map((frame) => frame.name));
        }
        socket.sendPacket(packet, this[symbol_1.kState].remotePort, this[symbol_1.kState].remoteAddress, callback);
        // debug(`%s session %s - write packet: %j`, this.id, packet.valueOf())
    }
    _sendWindowUpdate(offset, streamID) {
        if (streamID == null) {
            // update for session
            streamID = new protocol_1.StreamID(0);
        }
        debug(`%s session %s - write WindowUpdateFrame, streamID: %d, offset: %d`, protocol_1.SessionType[this[symbol_1.kType]], this.id, streamID.valueOf(), offset);
        this._sendFrame(new frame_1.WindowUpdateFrame(streamID, offset), (err) => {
            if (err != null) {
                this.emit('error', err);
            }
        });
    }
    _trySendAckFrame() {
        const frame = this[symbol_1.kACKHandler].toFrame();
        if (frame == null) {
            return;
        }
        debug(`%s session %s - write AckFrame, lowestAcked: %d, largestAcked: %d, ackRanges: %j`, protocol_1.SessionType[this[symbol_1.kType]], this.id, frame.lowestAcked, frame.largestAcked, frame.ackRanges);
        frame.setDelay();
        this._sendFrame(frame, (err) => {
            if (err != null) {
                this.destroy(err);
            }
        });
    }
    _handleRegularPacket(packet, rcvTime, bufv) {
        const packetNumber = packet.packetNumber.valueOf();
        this[symbol_1.kState].lastNetworkActivityTime = rcvTime;
        // if (!this[kHS].completed) {
        //   this[kHS].handlePacket(packet, rcvTime, bufv)
        //   if (this[kACKHandler].ack(packetNumber, rcvTime, packet.needAck())) {
        //     this._trySendAckFrame()
        //   }
        //   return
        // }
        packet.parseFrames(bufv);
        if (this[symbol_1.kACKHandler].ack(packetNumber, rcvTime, packet.needAck())) {
            this._trySendAckFrame();
        }
        debug(`%s session %s - received RegularPacket, packetNumber: %d, frames: %j`, protocol_1.SessionType[this[symbol_1.kType]], this.id, packetNumber, packet.frames.map((frame) => frame.name));
        for (const frame of packet.frames) {
            switch (frame.name) {
                case 'STREAM':
                    this._handleStreamFrame(frame, rcvTime);
                    break;
                case 'ACK':
                    this._handleACKFrame(frame, rcvTime);
                    break;
                case 'STOP_WAITING':
                    // The STOP_WAITING frame is sent to inform the peer that it should not continue to
                    // wait for packets with packet numbers lower than a specified value.
                    // The resulting least unacked is the smallest packet number of any packet for which the sender is still awaiting an ack.
                    // If the receiver is missing any packets smaller than this value,
                    // the receiver should consider those packets to be irrecoverably lost.
                    this._handleStopWaitingFrame(frame);
                    break;
                case 'WINDOW_UPDATE':
                    this._handleWindowUpdateFrame(frame);
                    break;
                case 'BLOCKED':
                    // The BLOCKED frame is used to indicate to the remote endpoint that this endpoint is
                    // ready to send data (and has data to send), but is currently flow control blocked.
                    // It is a purely informational frame.
                    this._handleBlockedFrame(frame, rcvTime);
                    break;
                case 'CONGESTION_FEEDBACK':
                    // The CONGESTION_FEEDBACK frame is an experimental frame currently not used.
                    break;
                case 'PADDING':
                    // When this frame is encountered, the rest of the packet is expected to be padding bytes.
                    return;
                case 'RST_STREAM':
                    this._handleRstStreamFrame(frame, rcvTime);
                    break;
                case 'PING':
                    // The PING frame contains no payload.
                    // The receiver of a PING frame simply needs to ACK the packet containing this frame.
                    break;
                case 'CONNECTION_CLOSE':
                    this.destroy(frame.error);
                    break;
                case 'GOAWAY':
                    this[symbol_1.kState].shuttingDown = true;
                    this.emit('goaway', frame.error);
                    break;
            }
        }
    }
    _handleStreamFrame(frame, rcvTime) {
        const streamID = frame.streamID.valueOf();
        let stream = this[symbol_1.kStreams].get(streamID);
        if (stream == null) {
            if (this[symbol_1.kState].shuttingDown) {
                return;
            }
            stream = new stream_1.Stream(frame.streamID, this, {});
            if (this[symbol_1.kState].liveStreamCount >= constant_1.DefaultMaxIncomingStreams) {
                stream.close(error_1.QuicError.fromError(error_1.QuicError.QUIC_TOO_MANY_AVAILABLE_STREAMS));
                return;
            }
            this[symbol_1.kStreams].set(streamID, stream);
            this[symbol_1.kState].liveStreamCount += 1;
            this.emit('stream', stream);
        }
        else if (stream.destroyed) {
            return;
        }
        stream._handleFrame(frame, rcvTime);
    }
    _handleRstStreamFrame(frame, rcvTime) {
        const streamID = frame.streamID.valueOf();
        const stream = this[symbol_1.kStreams].get(streamID);
        if (stream == null || stream.destroyed) {
            return;
        }
        stream._handleRstFrame(frame, rcvTime);
    }
    _handleACKFrame(frame, rcvTime) {
        // The sender must always close the connection if an unsent packet number is acked,
        // so this mechanism automatically defeats any potential attackers.
        if (frame.largestAcked >= this[symbol_1.kNextPacketNumber].valueOf()) {
            this.destroy(error_1.QuicError.fromError(error_1.QuicError.QUIC_INTERNAL_ERROR));
            return;
        }
        // It is recommended for the sender to send the most recent largest acked packet
        // it has received in an ack as the stop waiting frame’s least unacked value.
        if (frame.hasMissingRanges()) {
            this._sendStopWaitingFrame(frame.largestAcked);
        }
        this._retransmit(frame, rcvTime);
    }
    _handleStopWaitingFrame(frame) {
        this[symbol_1.kACKHandler].lowest(frame.leastUnacked.valueOf());
    }
    _handleWindowUpdateFrame(frame) {
        // The stream ID can be 0, indicating this WINDOW_UPDATE applies to the connection level flow control window,
        // or > 0 indicating that the specified stream should increase its flow control window.
        const streamID = frame.streamID.valueOf();
        const offset = frame.offset.valueOf();
        debug(`%s session %s - received WindowUpdateFrame, streamID: %d, offset: %d`, protocol_1.SessionType[this[symbol_1.kType]], this.id, streamID, offset);
        if (streamID === 0) {
            this[symbol_1.kFC].updateMaxSendOffset(offset);
        }
        else {
            const stream = this[symbol_1.kStreams].get(streamID);
            if (stream != null && !stream.destroyed) {
                if (stream[symbol_1.kFC].updateMaxSendOffset(offset)) {
                    stream._tryFlushCallbacks();
                }
            }
        }
    }
    _handleBlockedFrame(frame, rcvTime) {
        this[symbol_1.kFC].updateBlockedFrame(frame.streamID.valueOf(), rcvTime);
    }
    _intervalCheck(time) {
        if (this.destroyed) {
            return;
        }
        // The PING frame should be used to keep a connection alive when a stream is open.
        const sessionNetworkTime = this[symbol_1.kState].lastNetworkActivityTime || this[symbol_1.kState].startTime;
        if (this[symbol_1.kState].keepAlivePingSent && this[symbol_1.kStreams].size > 0 && (time - sessionNetworkTime >= constant_1.PingFrameDelay)) {
            this.ping().catch((err) => this.emit('error', err));
        }
        for (const stream of this[symbol_1.kStreams].values()) {
            const lastActivityTime = stream[symbol_1.kState].lastActivityTime || stream[symbol_1.kState].startTime;
            if (stream.destroyed) {
                // clearup idle stream
                if (time - lastActivityTime > this[symbol_1.kState].idleTimeout) {
                    this[symbol_1.kStreams].delete(stream.id);
                }
            }
            else if (time - lastActivityTime > constant_1.MaxStreamWaitingTimeout) {
                stream.emit('timeout');
            }
        }
        this._trySendAckFrame();
        return;
    }
    request(options) {
        if (this[symbol_1.kState].shuttingDown) {
            throw error_1.StreamError.fromError(error_1.StreamError.QUIC_STREAM_PEER_GOING_AWAY);
        }
        if (this[symbol_1.kState].liveStreamCount >= constant_1.DefaultMaxIncomingStreams) {
            throw error_1.QuicError.fromError(error_1.QuicError.QUIC_TOO_MANY_OPEN_STREAMS);
        }
        const streamID = this[symbol_1.kNextStreamID];
        this[symbol_1.kNextStreamID] = streamID.nextID();
        const stream = new stream_1.Stream(streamID, this, (options == null ? {} : options));
        this[symbol_1.kStreams].set(streamID.valueOf(), stream);
        this[symbol_1.kState].liveStreamCount += 1;
        return stream;
    }
    goaway(err) {
        return new Promise((resolve) => {
            if (this[symbol_1.kState].shuttingDown) {
                return resolve();
            }
            this[symbol_1.kState].shuttingDown = true;
            const frame = new frame_1.GoAwayFrame(this[symbol_1.kNextStreamID].prevID(), error_1.QuicError.fromError(err));
            debug(`%s session %s - write GoAwayFrame, streamID: %d, error: %j`, protocol_1.SessionType[this[symbol_1.kType]], this.id, frame.streamID.valueOf(), frame.error);
            this._sendFrame(frame, (_e) => {
                resolve();
            });
        });
    }
    ping() {
        return new Promise((resolve, reject) => {
            debug(`%s session %s - write PingFrame`, protocol_1.SessionType[this[symbol_1.kType]], this.id);
            this._sendFrame(new frame_1.PingFrame(), (err) => {
                if (err != null) {
                    reject(err);
                }
                else {
                    resolve();
                }
            });
        });
    }
    close(err) {
        return new Promise((resolve) => {
            if (this[symbol_1.kState].destroyed) {
                return resolve();
            }
            const frame = new frame_1.ConnectionCloseFrame(error_1.QuicError.fromError(err));
            debug(`%s session %s - write ConnectionCloseFrame, error: %j`, protocol_1.SessionType[this[symbol_1.kType]], this.id, frame.error);
            this._sendFrame(frame, (e) => {
                this.destroy(e);
                resolve();
            });
        });
    }
    reset(_err) {
        return new Promise((resolve) => {
            if (this[symbol_1.kState].destroyed) {
                return resolve();
            }
            const tags = new protocol_1.QuicTags(protocol_1.Tag.PRST);
            tags.set(protocol_1.Tag.RNON, Buffer.allocUnsafe(8)); // TODO
            tags.set(protocol_1.Tag.RSEQ, common_1.toBuffer(this[symbol_1.kNextPacketNumber].prevNumber()));
            const localAddr = this[symbol_1.kState].localAddr;
            if (localAddr != null) {
                tags.set(protocol_1.Tag.CADR, common_1.toBuffer(localAddr));
            }
            const packet = new packet_1.ResetPacket(this[symbol_1.kID], tags);
            debug(`%s session %s - write ResetPacket, packet: %j`, protocol_1.SessionType[this[symbol_1.kType]], this.id, packet);
            this._sendPacket(packet, (e) => {
                this.destroy(e);
                resolve();
            });
        });
    }
    destroy(err) {
        if (this[symbol_1.kState].destroyed) {
            return;
        }
        debug(`%s session %s - session destroyed, error: %j`, protocol_1.SessionType[this[symbol_1.kType]], this.id, err);
        err = error_1.QuicError.checkAny(err);
        if (err != null && err.isNoError) {
            err = null;
        }
        const socket = this[symbol_1.kSocket];
        if (socket != null) {
            socket[symbol_1.kState].conns.delete(this.id);
            if (this.isClient && !socket[symbol_1.kState].destroyed && (socket[symbol_1.kState].exclusive || socket[symbol_1.kState].conns.size === 0)) {
                socket.close();
                socket[symbol_1.kState].destroyed = true;
            }
            this[symbol_1.kSocket] = null;
        }
        for (const stream of this[symbol_1.kStreams].values()) {
            stream.destroy(err);
        }
        const timer = this[symbol_1.kIntervalCheck];
        if (timer != null) {
            clearInterval(timer);
        }
        this[symbol_1.kStreams].clear();
        this[symbol_1.kUnackedPackets].reset();
        if (err != null) {
            this.emit('error', err);
        }
        if (!this[symbol_1.kState].destroyed) {
            this[symbol_1.kState].destroyed = true;
            process.nextTick(() => this.emit('close'));
        }
        return;
    }
}
exports.Session = Session;
class SessionState {
    constructor() {
        this.localFamily = '';
        this.localAddress = '';
        this.localPort = 0;
        this.localAddr = null; // SocketAddress
        this.remoteFamily = '';
        this.remoteAddress = '';
        this.remotePort = 0;
        this.remoteAddr = null; // SocketAddress
        this.maxPacketSize = 0;
        this.bytesRead = 0;
        this.bytesWritten = 0;
        this.idleTimeout = constant_1.DefaultIdleTimeout;
        this.liveStreamCount = 0;
        this.startTime = Date.now();
        this.destroyed = false;
        this.shutdown = false;
        this.shuttingDown = false; // send or receive GOAWAY
        this.versionNegotiated = false;
        this.keepAlivePingSent = false;
    }
}
exports.SessionState = SessionState;
class ACKHandler {
    constructor() {
        this.misshit = 0;
        this.lowestAcked = 0;
        this.largestAcked = 0;
        this.numbersAcked = [];
        this.largestAckedTime = 0;
        this.lastAckedTime = Date.now();
    }
    lowest(packetNumber) {
        if (packetNumber > this.lowestAcked) {
            this.lowestAcked = packetNumber;
        }
    }
    ack(packetNumber, rcvTime, needAck) {
        if (packetNumber < this.lowestAcked) {
            return false; // ignore
        }
        if (packetNumber > this.largestAcked) {
            if (packetNumber - this.largestAcked > 1) {
                this.misshit += 1;
            }
            this.largestAcked = packetNumber;
            this.largestAckedTime = rcvTime;
        }
        else if (Math.abs(packetNumber - this.numbersAcked[0]) > 1) {
            this.misshit += 1;
        }
        let shouldAck = this.numbersAcked.unshift(packetNumber) >= 511; // 256 blocks + 255 gaps, too many packets, should ack
        if (!needAck && this.largestAcked - this.lowestAcked <= 1) {
            // ACK frame
            this.lowestAcked = this.largestAcked;
            this.numbersAcked.length = 1;
            return false;
        }
        if (this.misshit > 16) {
            shouldAck = true;
        }
        const timeSpan = rcvTime - this.lastAckedTime;
        if (timeSpan >= 512) {
            shouldAck = true;
        }
        if (shouldAck) {
            debug(`should ACK, largestAcked: %d, lowestAcked: %d, misshit: %d, numbersAcked: %d, timeSpan: %d`, this.largestAcked, this.lowestAcked, this.misshit, this.numbersAcked.length, timeSpan);
            this.lastAckedTime = rcvTime;
        }
        return shouldAck;
    }
    toFrame() {
        const numbersAcked = this.numbersAcked;
        if (numbersAcked.length === 0) {
            return null;
        }
        numbersAcked.sort((a, b) => b - a);
        if (numbersAcked[0] <= this.lowestAcked) {
            numbersAcked.length = 0;
            this.largestAcked = this.lowestAcked;
            return null;
        }
        const frame = new frame_1.AckFrame();
        frame.largestAcked = this.largestAcked;
        frame.largestAckedTime = this.largestAckedTime;
        let range = new frame_1.AckRange(this.largestAcked, this.largestAcked);
        // numbersAcked should include largestAcked and lowestAcked for this AGL
        for (let i = 1, l = numbersAcked.length; i < l; i++) {
            const num = numbersAcked[i];
            if (num < this.lowestAcked) {
                numbersAcked.length = i; // drop smaller numbers
                break;
            }
            const ret = numbersAcked[i - 1] - num;
            if (ret === 1) {
                range.first = num;
            }
            else if (ret > 1) {
                frame.ackRanges.push(range);
                range = new frame_1.AckRange(num, num);
            } // else ingnore
        }
        frame.lowestAcked = range.first;
        if (range.last < frame.largestAcked) {
            frame.ackRanges.push(range);
        }
        if (frame.ackRanges.length === 0) {
            this.lowestAcked = this.largestAcked;
            numbersAcked.length = 1;
        }
        else if (frame.ackRanges.length > 256) {
            // if ackRanges.length > 256, ignore some ranges between
            frame.ackRanges[255] = frame.ackRanges[frame.ackRanges.length - 1];
            frame.ackRanges.length = 256;
        }
        debug(`after build AckFrame, largestAcked: %d, lowestAcked: %d, numbersAcked: %j`, this.largestAcked, this.lowestAcked, numbersAcked);
        this.misshit = 0;
        return frame;
    }
}
exports.ACKHandler = ACKHandler;
//# sourceMappingURL=session.js.map