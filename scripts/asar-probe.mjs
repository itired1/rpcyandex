import fs from 'node:fs';

const p = process.argv[2];
const fd = fs.openSync(p, 'r');
const sizeBuf = Buffer.alloc(8);
fs.readSync(fd, sizeBuf, 0, 8, 0);
console.log('size pickle raw       :', sizeBuf.toString('hex'));
console.log('  payloadSize [0..4)  :', sizeBuf.readUInt32LE(0));
console.log('  headerSize  [4..8)  :', sizeBuf.readUInt32LE(4));

const headerSize = sizeBuf.readUInt32LE(4);
const hb = Buffer.alloc(headerSize);
fs.readSync(fd, hb, 0, headerSize, 8);
console.log('header pickle size    :', hb.length);
console.log('  hdr payloadSize[0..4):', hb.readUInt32LE(0));
const jsonLen = hb.readUInt32LE(4);
console.log('  jsonLength    [4..8):', jsonLen);
console.log('  json + 8            :', jsonLen + 8);
console.log('  tail padding bytes  :', hb.length - 8 - jsonLen);
console.log('  first 32 json chars :', hb.toString('utf8', 8, 40));
console.log('  last 24 header chars:', JSON.stringify(hb.toString('utf8', hb.length - 24, hb.length)));
console.log('baseOffset            :', 8 + headerSize);
console.log('file size             :', fs.statSync(p).size);

const header = JSON.parse(hb.toString('utf8', 8, 8 + jsonLen));
console.log('root keys             :', Object.keys(header));
fs.closeSync(fd);
