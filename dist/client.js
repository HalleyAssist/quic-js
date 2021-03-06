'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
// **Github:** https://github.com/fidm/quic
//
// **License:** MIT
const util_1 = require("util");
const constant_1 = require("./internal/constant");
const common_1 = require("./internal/common");
const error_1 = require("./internal/error");
const packet_1 = require("./internal/packet");
const protocol_1 = require("./internal/protocol");
const symbol_1 = require("./internal/symbol");
const socket_1 = require("./socket");
const handshake_1 = require("./handshake");
const session_1 = require("./session");
const debug = util_1.debuglog('quic');
//
// *************** Client ***************
//
class Client extends session_1.Session {
    constructor() {
        super(protocol_1.ConnectionID.random(), protocol_1.SessionType.CLIENT);
        this[symbol_1.kVersion] = protocol_1.getVersion();
        this[symbol_1.kHS] = new handshake_1.ClientHandShake(this);
        this[symbol_1.kClientState] = new ClientState();
        this[symbol_1.kIntervalCheck] = setInterval(() => {
            const time = Date.now();
            // client session idle timeout
            const sessionActivityTime = this[symbol_1.kState].lastNetworkActivityTime || this[symbol_1.kState].startTime;
            if (time - sessionActivityTime > this[symbol_1.kState].idleTimeout) {
                this.emit('timeout');
                this.close(error_1.QuicError.fromError(error_1.QuicError.QUIC_NETWORK_IDLE_TIMEOUT));
                return;
            }
            // other session check
            this._intervalCheck(time);
        }, 512);
    }
    _resendPacketsForNegotiation() {
        const packets = this[symbol_1.kUnackedPackets].toArray();
        this[symbol_1.kUnackedPackets].reset();
        for (const packet of packets) {
            this._sendPacket(packet, (err) => {
                if (err != null && !this.destroyed) {
                    this.destroy(err);
                }
            });
        }
    }
    setKeepAlive(enable, _initialDelay) {
        this[symbol_1.kState].keepAlivePingSent = enable;
        // initialDelay TODO
    }
    ref() {
        const socket = this[symbol_1.kSocket];
        if (socket == null) {
            throw new Error('Client not connect');
        }
        socket.ref();
    }
    unref() {
        const socket = this[symbol_1.kSocket];
        if (socket == null) {
            throw new Error('Client not connect');
        }
        socket.unref();
    }
    async spawn(port, address = 'localhost') {
        if (this[symbol_1.kState].destroyed) {
            throw new Error('Client destroyed');
        }
        const socket = this[symbol_1.kSocket];
        if (socket == null || socket[symbol_1.kState].destroyed) {
            throw new Error('the underlying socket destroyed');
        }
        const addr = await common_1.dnsLookup(address);
        debug(`client connect: %s, %d, %j`, address, port, addr);
        const client = new Client();
        socket[symbol_1.kState].conns.set(client.id, client);
        socket[symbol_1.kState].exclusive = false;
        client[symbol_1.kSocket] = socket;
        client[symbol_1.kState].localFamily = this[symbol_1.kState].localFamily;
        client[symbol_1.kState].localAddress = this[symbol_1.kState].localAddress;
        client[symbol_1.kState].localPort = this[symbol_1.kState].localPort;
        client[symbol_1.kState].localAddr = new protocol_1.SocketAddress(socket.address());
        client[symbol_1.kState].remotePort = port;
        client[symbol_1.kState].remoteAddress = addr.address;
        client[symbol_1.kState].remoteFamily = 'IPv' + addr.family;
        client[symbol_1.kState].remoteAddr =
            new protocol_1.SocketAddress({ port, address: addr.address, family: `IPv${addr.family}` });
        client[symbol_1.kState].maxPacketSize = this[symbol_1.kState].maxPacketSize;
        await new Promise((resolve, reject) => {
            client[symbol_1.kHS].once('secureConnection', () => {
                client.removeListener('error', reject);
                resolve();
            });
            client.once('error', reject);
            client[symbol_1.kHS].setup();
        });
        return client;
    }
    async connect(port, address = 'localhost') {
        if (this[symbol_1.kState].destroyed) {
            throw new Error('Client destroyed');
        }
        if (this[symbol_1.kSocket] != null) {
            throw new Error('Client connecting duplicated');
        }
        const addr = await common_1.dnsLookup(address);
        debug(`client connect: %s, %d, %j`, address, port, addr);
        this[symbol_1.kState].remotePort = port;
        this[symbol_1.kState].remoteAddress = addr.address;
        this[symbol_1.kState].remoteFamily = 'IPv' + addr.family;
        this[symbol_1.kState].remoteAddr = new protocol_1.SocketAddress({ port, address: addr.address, family: `IPv${addr.family}` });
        this[symbol_1.kState].maxPacketSize =
            this[symbol_1.kState].localFamily === protocol_1.FamilyType.IPv6 ? constant_1.MaxPacketSizeIPv6 : constant_1.MaxPacketSizeIPv4;
        const socket = this[symbol_1.kSocket] = socket_1.createSocket(addr.family);
        socket[symbol_1.kState].conns.set(this.id, this);
        socket
            .on('error', (err) => this.emit('error', err))
            .on('close', () => this.destroy(new Error('the underlying socket closed')))
            .on('message', socketOnMessage);
        const res = new Promise((resolve, reject) => {
            socket.once('listening', () => {
                socket.removeListener('error', reject);
                const localAddr = socket.address();
                this[symbol_1.kState].localFamily = localAddr.family;
                this[symbol_1.kState].localAddress = localAddr.address;
                this[symbol_1.kState].localPort = localAddr.port;
                this[symbol_1.kState].localAddr = new protocol_1.SocketAddress(localAddr);
                this[symbol_1.kHS].once('secureConnection', () => {
                    this.removeListener('error', reject);
                    process.nextTick(() => this.emit('connect'));
                    resolve();
                });
                this[symbol_1.kHS].setup();
            });
            this.once('error', reject);
            socket.once('error', reject);
        });
        socket.bind({ exclusive: true, port: 0 });
        await res;
    }
}
exports.Client = Client;
class ClientState {
    constructor() {
        this.hostname = '';
        this.receivedNegotiationPacket = false;
    }
}
exports.ClientState = ClientState;
function socketOnMessage(msg, rinfo) {
    if (msg.length === 0 || this[symbol_1.kState].destroyed) {
        return;
    }
    // The packet size should not exceed protocol.MaxReceivePacketSize bytes
    // If it does, we only read a truncated packet, which will then end up undecryptable
    if (msg.length > constant_1.MaxReceivePacketSize) {
        debug(`client message - receive too large data: %d bytes`, msg.length);
        // msg = msg.slice(0, MaxReceivePacketSize)
    }
    const senderAddr = new protocol_1.SocketAddress(rinfo);
    const rcvTime = Date.now();
    const bufv = new common_1.BufferVisitor(msg);
    let packet = null;
    try {
        packet = packet_1.parsePacket(bufv, protocol_1.SessionType.SERVER);
    }
    catch (err) {
        debug(`client message - parsing packet error: %o`, err);
        // drop this packet if we can't parse the Public Header
        return;
    }
    const connectionID = packet.connectionID.valueOf();
    const client = this[symbol_1.kState].conns.get(connectionID);
    if (client == null) {
        // reject packets with the wrong connection ID
        debug(`client message - received a spoofed packet with wrong ID: %s`, connectionID);
        return;
    }
    else if (client.destroyed) {
        // Late packet for closed session
        return;
    }
    if (packet.isReset()) {
        // check if the remote address and the connection ID match
        // otherwise this might be an attacker trying to inject a PUBLIC_RESET to kill the connection
        const remoteAddr = client[symbol_1.kState].remoteAddr;
        if (remoteAddr == null || !remoteAddr.equals(senderAddr)) {
            debug(`session %s - received a spoofed Public Reset: %j`, client.id, senderAddr);
            return;
        }
        debug(`session %s - Public Reset, rejected packet number: %j`, client.id, packet);
        client.destroy(error_1.QuicError.fromError(error_1.QuicError.QUIC_PUBLIC_RESET));
        return;
    }
    if (packet.isNegotiation()) {
        // ignore delayed / duplicated version negotiation packets
        if (client[symbol_1.kClientState].receivedNegotiationPacket || client[symbol_1.kState].versionNegotiated) {
            return;
        }
        const versions = packet.versions;
        if (client[symbol_1.kVersion] !== '' && versions.includes(client[symbol_1.kVersion])) {
            // the version negotiation packet contains the version that we offered
            // this might be a packet sent by an attacker (or by a terribly broken server implementation)
            // ignore it
            return;
        }
        const newVersion = protocol_1.chooseVersion(versions);
        client[symbol_1.kClientState].receivedNegotiationPacket = true;
        debug(`session %s - received Public Negotiation: %s`, client.id, newVersion);
        if (newVersion !== '') {
            // switch to negotiated version
            client[symbol_1.kVersion] = newVersion;
            client._resendPacketsForNegotiation();
        }
        else {
            client.destroy(error_1.QuicError.fromError(error_1.QuicError.QUIC_INVALID_VERSION));
        }
        return;
    }
    // this is the first packet after the client sent a packet with the VersionFlag set
    // if the server doesn't send a version negotiation packet, it supports the suggested version
    if (!client[symbol_1.kState].versionNegotiated) {
        client[symbol_1.kState].versionNegotiated = true;
        client.emit('version', client.version);
    }
    client[symbol_1.kState].bytesRead += msg.length;
    try {
        client._handleRegularPacket(packet, rcvTime, bufv);
    }
    catch (err) {
        debug(`CLIENT session %s - handle RegularPacket error: %o`, client.id, err);
        client.destroy(error_1.QuicError.fromError(err));
    }
}
//# sourceMappingURL=client.js.map