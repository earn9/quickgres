// Quickgres is a PostgreSQL client library.
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const assert = require('assert');

function r32(buf, off){ return (buf[off] << 24) | (buf[off+1] << 16) | (buf[off+2] << 8) | buf[off+3]; }
function r16(buf, off){ return (buf[off] << 8) | buf[off+1]; }

function w32(buf, v, off) { // Write 32-bit big-endian int
    buf[off++] = (v >> 24) & 0xFF;
    buf[off++] = (v >> 16) & 0xFF;
    buf[off++] = (v >> 8) & 0xFF;
    buf[off++] = v & 0xFF;
    return off;
}
function w16(buf, v, off) { // Write 16-bit big-endian int
    buf[off++] = (v >> 8) & 0xFF;
    buf[off++] = v & 0xFF;
    return off;
}
function wstr(buf, str, off) { // Write null-terminated string
    off += buf.write(str, off);
    buf[off++] = 0;
    return off;
}
function wstrLen(buf, str, off) { // Write buffer length, followed by buffer contents
    if (str === null) return w32(buf, -1, off);
    const src = Buffer.from(str);
    off = w32(buf, src.byteLength, off);
    return off + src.copy(buf, off);
}
function slice(buf, start, end) { // Copying slice, used to work around full sockets not copying write buffers
    const dst = Buffer.allocUnsafe(end - start);
    buf.copy(dst, 0, start, end);
    return dst;
}

class Client {
    constructor(config) {
        assert(config.user, "No 'user' defined in config");
        assert(config.database, "No 'database' defined in config");
        this._parsedStatementCount = 1;
        this._parsedStatements = {};
        this._packet = { buf: Buffer.alloc(2**16), cmd: 0, len: 0, idx: 0 };
        this._wbuf = Buffer.alloc(2**16);
        this._outStreams = [];
        this.authenticationOk = false;
        this.serverParameters = {};
        this.packetExecutor = this.packetExecutor.bind(this);
        this.streamExecutor = this.streamExecutor.bind(this);
        this.config = config;
    }
    connect(address, host) {
        this._connection = net.createConnection(address, host);
        this._connection.once('connect', this.onInitialConnect.bind(this));
        return new Promise(this.packetExecutor);
    }
    end() { 
        this.terminate();
        return this._connection.end();
    }
    onError(err) { this._outStreams.splice(0).forEach(s => s.reject(err)); }
    onInitialConnect() {
        if (this.config.ssl) {
            this._connection.once('data', this.onSSLResponse.bind(this));
            w32(this._wbuf, 8, 0);
            w32(this._wbuf, 80877103, 4);  // SSL Request
            this._connection.write(slice(this._wbuf, 0, 8));
        } else {
            this.onConnect();
        }
    }
    onSSLResponse(buffer) {
        if (buffer[0] !== 83) throw Error("Error establishing an SSL connection");
        this._connection = tls.connect({socket: this._connection, ...this.config.ssl}, this.onConnect.bind(this));
    }
    onConnect() {
        this._connection.on('data', this.onData.bind(this));
        this._connection.on('error', this.onError.bind(this));
        let off = 4;
        off = w16(this._wbuf, 3, off); // Protocol major version 3
        off = w16(this._wbuf, 0, off); // Protocol minor version 0
        const filteredKeys = {password: 1, ssl: 1};
        for (let n in this.config) {
            if (filteredKeys[n]) continue;
            off = wstr(this._wbuf, n, off); // overflow
            off = wstr(this._wbuf, this.config[n], off); // overflow
        }
        this._wbuf[off++] = 0;
        w32(this._wbuf, off, 0);
        this._connection.write(slice(this._wbuf, 0, off));
    }
    onData(buf) {
        const packet = this._packet;
        for (var i = 0; i < buf.byteLength;) {
            if (packet.cmd === 0) {
                packet.cmd = buf[i++];
                packet.buf[0] = packet.cmd;
                packet.length = 0;
                packet.index = 0;
            } else if (packet.index < 4) {
                packet.buf[++packet.index] = buf[i++];
                if (packet.index === 4) {
                    packet.length = r32(packet.buf, 1);
                    if (packet.buf.byteLength < packet.length+1) {
                        const newBuf = Buffer.allocUnsafe(packet.length+1);
                        packet.buf.copy(newBuf, 0, 0, 5);
                        packet.buf = newBuf;
                    }
                }
            }
            if (packet.index >= 4) {
                const slice = buf.slice(i, i + (packet.length - packet.index));
                slice.copy(packet.buf, packet.index+1);
                packet.index += slice.byteLength;
                i += slice.byteLength;
                if (packet.index === packet.length) {
                    this.processPacket(packet);
                    packet.cmd = 0;
                }
            }
        }
    }
    processPacket(packet, off=5, outStream=this._outStreams[0]) {
        const { buf, cmd, length } = packet;
        switch (cmd) {
            case 68: // D -- DataRow
                if (outStream) {
                    outStream.stream.rowParser = outStream.parsed.rowParser;
                    outStream.stream.write(buf.slice(0, length+1));
                }
                break;
            case 100: // CopyData
                if (outStream) outStream.stream.write(buf.slice(0, length+1));
                break;
            case 84: // T -- RowDescription
                if (outStream) outStream.parsed.rowParser = new RowParser(buf);
            case 73: // I -- EmptyQueryResponse
            case 72: // CopyOutResponse
            case 87: // CopyBothResponse
            case 99: // CopyDone
                if (outStream) outStream.stream.write(buf.slice(0, length+1));
            case 110: // NoData
            case 116: // ParameterDescription
            case 49: // 1 -- ParseComplete
            case 50: // 2 -- BindComplete
            case 51: // 3 -- CloseComplete
                break;
            case 67: // C -- CommandComplete
                if (this.inQuery) {
                    this.inQuery = false;
                    this.sync();
                }
                if (outStream) {
                    outStream.stream.write(buf.slice(0, length+1));
                }
                break;
            case 115: // s -- PortalSuspended
            case 71: // CopyInResponse
                if (outStream) {
                    outStream.stream.write(buf.slice(0, length+1));
                    this._outStreams.shift();
                    outStream.resolve(outStream.stream);
                }
                break;
            case 90: // Z -- ReadyForQuery
                this.inQuery = this.inQueryParsed = null;
                if (outStream) {
                    this._outStreams.shift();
                    outStream.resolve(outStream.stream);
                }
                break;
            case 69: // E -- Error
                const fieldType = buf[off]; ++off;
                const string = buf.toString('utf8', off, off + length - 5);
                console.error(cmd, String.fromCharCode(cmd), length, fieldType, string);
                if (outStream) {
                    this._outStreams.shift();
                    outStream.reject(Error(string));
                }
                break;
            case 83: // S -- ParameterStatus
                const kv = buf.toString('utf8', off, off + length - 5)
                const [key, value] = kv.split('\0');
                this.serverParameters[key] = value;
                break;
            case 82: // R -- Authentication
                const authResult = r32(buf, off); off += 4;
                if (authResult === 0) this.authenticationOk = true;
                else if (authResult === 3) { // 3 -- AuthenticationCleartextPassword
                    assert(this.config.password !== undefined, "No password supplied");
                    this.authResponse(Buffer.from(this.config.password + '\0')); 
                } else if (authResult === 5) { // 5 -- AuthenticationMD5Password
                    assert(this.config.password !== undefined, "No password supplied");
                    const upHash = crypto.createHash('md5').update(this.config.password).update(this.config.user).digest('hex');
                    const salted = crypto.createHash('md5').update(upHash).update(buf.slice(off, off+4)).digest('hex');
                    this.authResponse(Buffer.from(`md5${salted}\0`)); 
                } else { this.end(); throw(Error(`Authentication method ${authResult} not supported`)); }
                break;
            case 75: // K -- BackendKeyData
                this.backendKey = Buffer.from(buf.slice(off, off + length - 4));
                break;
            case 118: // NegotiateProtocolVersion
            case 78: // NoticeResponse
            case 65: // NotificationResponse
            case 86: // FunctionCallResponse -- Legacy, not supported.
            default:
                console.error(cmd, String.fromCharCode(cmd), length, buf.toString('utf8', off, off + length - 4));
        }
    }
    packetExecutor(resolve, reject) { this._outStreams.push({resolve, reject}); }
    streamExecutor(resolve, reject) {
        this._outStreams.push({stream: this._tmpStream, parsed: this._tmpParsed, resolve, reject}); 
        this._tmpParsed = null;
        this._tmpStream = null;
    }
    streamPromise(stream=new ObjectReader(), parsed={name: '', rowParser: null}) {
        this._tmpStream = stream;
        this._tmpParsed = parsed;
        return new Promise(this.streamExecutor);
    }
    parse(statementName, statement, types=[]) {
        let off = 5; this._wbuf[0] = 80; // P -- Parse
        off = wstr(this._wbuf, statementName, off); // overflow
        off = wstr(this._wbuf, statement, off); // overflow
        off = w16(this._wbuf, types.length, off); // max 262144 + 2
        for (let i = 0; i < types.length; i++) off = w32(this._wbuf, types[i], off);
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
    }
    bind(portalName, statementName, values=[], valueFormats=[], resultFormats=[]) {
        let off = 5; this._wbuf[0] = 66; // B -- Bind
        off = wstr(this._wbuf, portalName, off); // overflow
        off = wstr(this._wbuf, statementName, off); // overflow
        off = w16(this._wbuf, valueFormats.length, off); // max 131072 + 2
        for (let i = 0; i < valueFormats.length; i++) off = w16(this._wbuf, valueFormats[i], off);
        off = w16(this._wbuf, values.length, off);
        for (let i = 0; i < values.length; i++) { // overflow 65536 * (4 + str)
            if (values[i] === null) off = w32(this._wbuf, -1, off);
            else off = wstrLen(this._wbuf, values[i], off); // overflow
        }
        off = w16(this._wbuf, resultFormats.length, off); // max 131072 + 2
        for (let i = 0; i < resultFormats.length; i++) off = w16(this._wbuf, resultFormats[i], off);
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
    }
    execute(portalName, maxRows=0) {
        let off = 5; this._wbuf[0] = 69; // E -- Execute
        off = wstr(this._wbuf, portalName, off); // overflow
        off = w32(this._wbuf, maxRows, off);
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
    }
    close(type, name) {
        const promise = new Promise(this.packetExecutor);
        let off = 5; this._wbuf[0] = 67; // C -- Close
        this._wbuf[off++] = type;
        off = wstr(this._wbuf, name, off);  // overflow
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
        return promise;
    }
    describe(type, name)  { 
        let off = 5; this._wbuf[0] = 68; // D -- Describe
        this._wbuf[off++] = type;
        off = wstr(this._wbuf, name, off); // overflow
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
    }
    describeStatement(name) { return this.describe(83, name); } // S -- Statement
    describePortal(name) { return this.describe(80, name); } // P -- Portal
    authResponse(buffer) { return this.bufferCmd(112, buffer); } // p -- PasswordMessage/GSSResponse/SASLInitialResponse/SASLResponse
    copyData(buffer) { return this.bufferCmd(100, buffer); } // d -- CopyData
    copyFail(buffer) { return this.bufferCmd(102, buffer); } // f -- CopyFail
    bufferCmd(cmd, buffer, promise) {
        this._wbuf[0] = cmd;
        w32(this._wbuf, 4 + buffer.byteLength, 1);
        this._connection.write(slice(this._wbuf, 0, 5));
        this._connection.write(buffer);
        return promise;
    }
    copyDone()   { return this.zeroParamCmd(99); } // c -- CopyDone
    flush()      { return this.zeroParamCmd(72); } // H -- Flush
    sync()       { return this.zeroParamCmd(83); } // S -- Sync
    terminate()  { return this.zeroParamCmd(88); } // X -- Terminate
    zeroParamCmd(cmd) {
        this._wbuf[0] = cmd;
        this._wbuf[1] = this._wbuf[2] = this._wbuf[3] = 0; this._wbuf[4] = 4;
        this._connection.write(slice(this._wbuf, 0, 5));
    }
    getParsedStatement(statement) {
        let parsed = this._parsedStatements[statement];
        if (!parsed) {
            let name = this._parsedStatementCount.toString();
            this._parsedStatements[statement] = parsed = {name, rowParser: null};
            this._parsedStatementCount++;
            this.parse(name, statement);
            this.describeStatement(name);
        }
        return parsed;
    }
    startQuery(statement, values=[]) {
        const parsed = this.getParsedStatement(statement);
        this.bind('', parsed.name, values);
        this.inQuery = true;
        this.inQueryParsed = parsed;
    }
    getResults(maxCount=0, stream=new ObjectReader()) {
        this.execute('', maxCount);
        this.flush();
        return this.streamPromise(stream, this.inQueryParsed);
    }
    simpleQuery(statement, stream=new ObjectReader()) {
        let off = 5; this._wbuf[0] = 81; // Q -- Query
        off = wstr(this._wbuf, statement, off); // overflow
        w32(this._wbuf, off-1, 1);
        this._connection.write(slice(this._wbuf, 0, off));
        return this.streamPromise(stream, {name: '', rowParser: null});
    }
    query(statement, values=[], stream=new ObjectReader()) {
        const parsed = this.getParsedStatement(statement);
        this.bind('', parsed.name, values);
        this.execute('');
        this.sync();
        return this.streamPromise(stream, parsed);
    }
    copyTo(statement, values, stream=new CopyReader()) {
        this.parse('', statement);
        this.bind('', '', values);
        this.execute('');
        this.sync();
        return this.streamPromise(stream, {name: '', rowParser: null});
    }
    copyFrom(statement, values, stream=new CopyReader()) {
        this.parse('', statement);
        this.bind('', '', values);
        this.execute('');
        return this.streamPromise(stream, {name: '', rowParser: null});
    }
}

class ObjectReader {
    constructor() { this.rows = [], this.completes = []; }
    write(chunk) {
        if (chunk[0] === 68) this.rows.push(this.rowParser.parse(chunk)); // D -- DataRow
        else if (chunk[0] === 67) this.completes.push(RowParser.parseComplete(chunk)); // C -- CommandComplete
        else if (chunk[0] === 73) this.completes.push({cmd: 'EMPTY', oid: undefined, rowCount: 0}); // I -- EmptyQueryResult
        else if (chunk[0] === 115) this.completes.push({cmd: 'SUSPENDED', oid: undefined, rowCount: 0}); // s -- PortalSuspended
    }
}
class ArrayReader {
    constructor() { this.rows = [], this.completes = []; }
    write(chunk) { 
        if (chunk[0] === 68) this.rows.push(RowParser.parseArray(chunk)); // D -- DataRow 
        else if (chunk[0] === 67) this.completes.push(RowParser.parseComplete(chunk)); // C -- CommandComplete
        else if (chunk[0] === 73) this.completes.push({cmd: 'EMPTY', oid: undefined, rowCount: 0}); // I -- EmptyQueryResult
        else if (chunk[0] === 115) this.completes.push({cmd: 'SUSPENDED', oid: undefined, rowCount: 0}); // s -- PortalSuspended
    }
}
class CopyReader {
    constructor() { this.rows = []; }
    write(chunk, off=0) {
        const cmd = chunk[off]; off++;
        const length = r32(chunk, off); off += 4;
        switch(cmd) {
            case 100: // CopyData
                this.rows.push(slice(chunk, off, off + length - 4));
                break;
            case 71: // CopyInResponse
            case 87: // CopyBothResponse
            case 72: // CopyOutResponse
                this.format = chunk[off]; off++;
                this.columnCount = r16(chunk, off); off += 2;
                this.columnFormats = [];
                for (let i = 0; i < this.columnCount; i++) this.columnFormats[i] = r16(chunk, off), off += 2;
                break;
            case 99: // CopyDone
                this.completed = true;
                break;
        }
    }
}

class RowParser {
    constructor(buf) {
        this.fields = [], this.fieldNames = [];
        let off = 5;
        const fieldCount = r16(buf, off); off += 2;
        for (let i = 0; i < fieldCount; i++) {
            const nameEnd =  buf.indexOf(0, off);
            const name = buf.toString('utf8', off, nameEnd); off = nameEnd + 1;
            const tableOid = r32(buf, off); off += 4;
            const tableColumnIndex = r16(buf, off); off += 2;
            const typeOid = r32(buf, off); off += 4;
            const typeLen = r16(buf, off); off += 2;
            const typeModifier = r32(buf, off); off += 4;
            const binary = r16(buf, off); off += 2;
            const field = { name, tableOid, tableColumnIndex, typeOid, typeLen, typeModifier, binary };
            this.fields.push(field);
        }
        this.fieldObj = function() {};
        this.fieldObj.prototype = this.fields.reduce((o,f) => (o[f.name]='', o), {});
    }
    parse(buf, off=0, dst=new this.fieldObj()) {
        const fieldCount = r16(buf, off+5); off += 7;
        for (let i = 0; i < fieldCount; i++) off = RowParser.parseField(buf, off, dst, this.fields[i].name);
        return dst;
    }
}
RowParser.parseComplete = function(buf) {
    const str = buf.toString('utf8', 5, 1 + r32(buf, 1));
    const [_, cmd, oid, rowCount] = str.match(/^(\S+)( \d+)?( \d+)\u0000/) || str.match(/^(\S+)\u0000/);
    return {cmd, oid, rowCount: parseInt(rowCount || 0)};
};
RowParser.parseField = function(buf, off, dst, field) {
    const fieldLength = r32(buf, off); off += 4;
    if (fieldLength < 0) dst[field] = null;
    else dst[field] = buf.toString('utf8', off, off + fieldLength), off += fieldLength;
    return off;
}
RowParser.parseArray = function(buf, off=0, dst=[]) {
    const fieldCount = r16(buf, off+5); off += 7;
    for (let i = 0; i < fieldCount; i++) off = RowParser.parseField(buf, off, dst, i);
    return dst;
}

module.exports = { Client, ObjectReader, ArrayReader, CopyReader, RowParser };