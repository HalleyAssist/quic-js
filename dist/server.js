'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
// **Github:** https://github.com/fidm/quic
//
// **License:** MIT
const util_1 = require("util");
const events_1 = require("events");
const constant_1 = require("./internal/constant");
const common_1 = require("./internal/common");
const error_1 = require("./internal/error");
const packet_1 = require("./internal/packet");
const symbol_1 = require("./internal/symbol");
const protocol_1 = require("./internal/protocol");
const crypto_1 = require("./internal/crypto");
const socket_1 = require("./socket");
const handshake_1 = require("./handshake");
const session_1 = require("./session");
const debug = util_1.debuglog('quic');
class ServerSession extends session_1.Session {
    constructor(id, socket, server) {
        super(id, protocol_1.SessionType.SERVER);
        this[symbol_1.kSocket] = socket;
        this[symbol_1.kServer] = server;
        this[symbol_1.kHS] = new handshake_1.ServerHandShake(this, server[symbol_1.kState].sourceToken, server[symbol_1.kState].scfg);
        this[symbol_1.kState].localPort = server.localPort;
        this[symbol_1.kState].localAddress = server.localAddress;
        this[symbol_1.kState].localFamily = server.localFamily;
        this[symbol_1.kState].localAddr = new protocol_1.SocketAddress(server.address());
        this[symbol_1.kState].maxPacketSize =
            server.localFamily === protocol_1.FamilyType.IPv6 ? constant_1.MaxPacketSizeIPv6 : constant_1.MaxPacketSizeIPv4;
    }
    get server() {
        return this[symbol_1.kServer];
    }
}
exports.ServerSession = ServerSession;
class ServerState {
    constructor() {
        this.destroyed = false;
        this.scfg = new handshake_1.ServerConfig(null);
        this.sourceToken = new crypto_1.SourceToken();
    }
}
exports.ServerState = ServerState;
//
// *************** Server ***************
//
class Server extends events_1.EventEmitter {
    constructor() {
        super();
        this[symbol_1.kSocket] = null;
        this.localFamily = '';
        this.localAddress = '';
        this.localPort = 0;
        this.listening = false;
        this[symbol_1.kConns] = new Map();
        this[symbol_1.kState] = new ServerState();
        this[symbol_1.kIntervalCheck] = setInterval(() => {
            const time = Date.now();
            this._intervalCheck(time);
        }, 1024);
    }
    address() {
        return { port: this.localPort, family: this.localFamily, address: this.localAddress };
    }
    async listen(port, address = 'localhost') {
        if (this[symbol_1.kSocket] != null) {
            throw new Error('Server listening');
        }
        const addr = await common_1.dnsLookup(address);
        debug(`server listen: ${address}, ${port}`, addr);
        const socket = this[symbol_1.kSocket] = socket_1.createSocket(addr.family);
        socket[symbol_1.kState].exclusive = false; // socket is shared between all sessions
        socket
            .on('error', (err) => this.emit('error', err))
            .on('close', () => serverOnClose(this))
            .on('message', (msg, rinfo) => serverOnMessage(this, socket, msg, rinfo));
        const res = new Promise((resolve, reject) => {
            socket.once('listening', () => {
                socket.removeListener('error', reject);
                const localAddr = socket.address();
                this.localFamily = localAddr.family;
                this.localAddress = localAddr.address;
                this.localPort = localAddr.port;
                this.listening = true;
                process.nextTick(() => this.emit('listening'));
                resolve();
            });
            socket.once('error', reject);
        });
        // Can't support cluster
        socket.bind({ port, address: addr.address, exclusive: true });
        return res;
    }
    _intervalCheck(time) {
        for (const session of this[symbol_1.kConns].values()) {
            // server session idle timeout
            const sessionActivityTime = session[symbol_1.kState].lastNetworkActivityTime || session[symbol_1.kState].startTime;
            if (time - sessionActivityTime > session[symbol_1.kState].idleTimeout) {
                // When a server decides to terminate an idle connection,
                // it should not notify the client to avoid waking up the radio on mobile devices.
                if (!session.destroyed) {
                    session.emit('timeout');
                    session.destroy(error_1.QuicError.fromError(error_1.QuicError.QUIC_NETWORK_IDLE_TIMEOUT));
                }
                this[symbol_1.kConns].delete(session.id);
                return;
            }
            // other session check
            session._intervalCheck(time);
        }
        return;
    }
    shutdown(_timeout) {
        return Promise.reject('TODO');
    }
    async close(err) {
        if (this[symbol_1.kState].destroyed) {
            return;
        }
        this[symbol_1.kState].destroyed = true;
        for (const session of this[symbol_1.kConns].values()) {
            await session.close(err);
        }
        const timer = this[symbol_1.kIntervalCheck];
        if (timer != null) {
            clearInterval(timer);
        }
        const socket = this[symbol_1.kSocket];
        if (socket != null && !socket[symbol_1.kState].destroyed) {
            socket.close();
            socket[symbol_1.kState].destroyed = true;
        }
        process.nextTick(() => this.emit('close'));
    }
    getConnections() {
        return Promise.resolve(this[symbol_1.kConns].size); // TODO
    }
    ref() {
        const socket = this[symbol_1.kSocket];
        if (socket == null) {
            throw new Error('Server not listen');
        }
        socket.ref();
    }
    unref() {
        const socket = this[symbol_1.kSocket];
        if (socket == null) {
            throw new Error('Server not listen');
        }
        socket.unref();
    }
}
exports.Server = Server;
function serverOnClose(server) {
    for (const session of server[symbol_1.kConns].values()) {
        session.destroy(new Error('the underlying socket closed'));
    }
    // server[kConns].clear()
    if (!server[symbol_1.kState].destroyed) {
        const timer = server[symbol_1.kIntervalCheck];
        if (timer != null) {
            clearInterval(timer);
        }
        server[symbol_1.kState].destroyed = true;
        server.emit('close');
    }
}
function serverOnMessage(server, socket, msg, rinfo) {
    if (msg.length === 0 || server[symbol_1.kState].destroyed) {
        return;
    }
    // The packet size should not exceed protocol.MaxReceivePacketSize bytes
    // If it does, we only read a truncated packet, which will then end up undecryptable
    if (msg.length > constant_1.MaxReceivePacketSize) {
        debug(`server message - receive too large data: $d bytes`, msg.length);
        // msg = msg.slice(0, MaxReceivePacketSize)
    }
    const senderAddr = new protocol_1.SocketAddress(rinfo);
    const rcvTime = Date.now();
    const bufv = new common_1.BufferVisitor(msg);
    let packet = null;
    try {
        packet = packet_1.parsePacket(bufv, protocol_1.SessionType.CLIENT);
    }
    catch (err) {
        debug(`server message - parsing packet error: %o`, err);
        // drop this packet if we can't parse the Public Header
        return;
    }
    if (packet.isNegotiation()) {
        debug(`server message - Received a unexpect Negotiation packet.`);
        return;
    }
    const connectionID = packet.connectionID.valueOf();
    let session = server[symbol_1.kConns].get(connectionID);
    const newSession = session == null;
    if (session == null) {
        if (packet.isReset()) {
            return;
        }
        session = new ServerSession(packet.connectionID, socket, server);
        server[symbol_1.kConns].set(connectionID, session);
        debug(`server message - new session: %s`, connectionID);
    }
    else if (session.destroyed) {
        // Late packet for closed session
        return;
    }
    if (packet.isReset()) {
        // check if the remote address and the connection ID match
        // otherwise this might be an attacker trying to inject a PUBLIC_RESET to kill the connection
        const remoteAddr = session[symbol_1.kState].remoteAddr;
        if (remoteAddr !== null && !remoteAddr.equals(senderAddr)) {
            debug(`session %s - received a spoofed Public Reset: %j`, session.id, senderAddr);
            return;
        }
        debug(`session %s - received a Public Reset: %j`, session.id, packet);
        session.destroy(error_1.QuicError.fromError(error_1.QuicError.QUIC_PUBLIC_RESET));
        return;
    }
    // update the remote address, even if unpacking failed for any other reason than a decryption error
    session[symbol_1.kState].remotePort = senderAddr.port;
    session[symbol_1.kState].remoteAddress = senderAddr.address;
    session[symbol_1.kState].remoteFamily = senderAddr.family;
    session[symbol_1.kState].remoteAddr = senderAddr;
    const version = packet.version;
    if (!session[symbol_1.kState].versionNegotiated) {
        if (!protocol_1.isSupportedVersion(version)) {
            const negotiationPacket = packet_1.NegotiationPacket.fromConnectionID(session[symbol_1.kID]);
            debug(`session %s - send Public Negotiation: %j`, session.id, negotiationPacket);
            session._sendPacket(negotiationPacket, (err) => {
                if (err != null && session != null) {
                    session.close(err);
                }
            });
            return;
        }
        session[symbol_1.kVersion] = version;
        session[symbol_1.kState].versionNegotiated = true;
    }
    else if (version !== '' && session[symbol_1.kVersion] !== version) {
        debug(`session %s - invalid version in RegularPacket: %s`, session.id, version);
        return;
    }
    if (newSession) {
        server.emit('session', session);
        // session[kHS].once('secureConnection', () => server.emit('session', session))
    }
    session[symbol_1.kState].bytesRead += msg.length;
    try {
        session._handleRegularPacket(packet, rcvTime, bufv);
    }
    catch (err) {
        debug(`SERVER session %s - handle RegularPacket error: %o`, session.id, err);
        session.destroy(error_1.QuicError.fromError(err));
    }
}
//# sourceMappingURL=server.js.map