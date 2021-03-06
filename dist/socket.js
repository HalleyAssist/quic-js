'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
// **Github:** https://github.com/fidm/quic
//
// **License:** MIT
const dgram_1 = require("dgram");
const symbol_1 = require("./internal/symbol");
const error_1 = require("./internal/error");
const common_1 = require("./internal/common");
const constant_1 = require("./internal/constant");
class SocketState {
    constructor() {
        this.exclusive = true;
        this.destroyed = false;
        this.conns = new Map();
    }
}
exports.SocketState = SocketState;
function createSocket(family) {
    const socket = dgram_1.createSocket(family === 6 ? 'udp6' : 'udp4');
    const state = new SocketState();
    socket.once('close', () => {
        state.destroyed = true;
        socket.removeAllListeners();
    });
    Object.assign(socket, {
        [symbol_1.kState]: state,
        sendPacket,
    });
    return socket;
}
exports.createSocket = createSocket;
const bufferPool = [];
function sendPacket(packet, remotePort, remoteAddr, callback) {
    const byteLen = packet.byteLen();
    if (byteLen > constant_1.MaxReceivePacketSize) {
        return callback(new error_1.QuicError('packet size too large!'));
    }
    if (this[symbol_1.kState].destroyed) {
        return callback(new error_1.QuicError('socket destroyed!'));
    }
    let bufv = bufferPool.shift();
    if (bufv == null) {
        bufv = new common_1.BufferVisitor(Buffer.alloc(constant_1.MaxReceivePacketSize));
    }
    else {
        bufv.reset();
    }
    packet.writeTo(bufv);
    this.send(bufv.buf, 0, bufv.end, remotePort, remoteAddr, (err) => {
        packet.sentTime = Date.now();
        bufferPool.push(bufv);
        callback(error_1.QuicError.checkAny(err));
    });
}
//# sourceMappingURL=socket.js.map