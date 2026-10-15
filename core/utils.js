const net = require('node:net');
const dgram = require('node:dgram');
function iptoBuffer(ip, buffer, offset = 0) {
  const family = net.isIP(ip);
  if (!family || ip.includes('%')) throw new TypeError('Invalid IP address.');
  const size = family === 4 ? 4 : 16;
  if (!Number.isInteger(offset) || offset < 0 || (buffer && offset + size > buffer.length))
    throw new RangeError('Invalid address buffer bounds.');
  const out = buffer ?? Buffer.alloc(offset + size);
  if (family === 4)
    ip.split('.').forEach((part, i) => {
      out[offset + i] = Number(part);
    });
  else {
    if (ip.includes('.')) {
      const index = ip.lastIndexOf(':');
      const v4 = iptoBuffer(ip.slice(index + 1));
      ip =
        ip.slice(0, index + 1) +
        v4.readUInt16BE().toString(16) +
        ':' +
        v4.readUInt16BE(2).toString(16);
    }
    const halves = ip.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const groups =
      halves.length === 2
        ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
        : left;
    groups.forEach((group, i) => out.writeUInt16BE(parseInt(group, 16), offset + i * 2));
  }
  return out;
}
function ip4toBuffer(ip, buffer, offset) {
  if (!net.isIPv4(ip)) throw new TypeError('Invalid IPv4 address.');
  return iptoBuffer(ip, buffer, offset);
}
function ip6toBuffer(ip, buffer, offset) {
  if (!net.isIPv6(ip)) throw new TypeError('Invalid IPv6 address.');
  return iptoBuffer(ip, buffer, offset);
}
function iptoString(buffer, offset = 0, length = buffer.length - offset) {
  if (
    !Buffer.isBuffer(buffer) ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset + length > buffer.length ||
    ![4, 16].includes(length)
  )
    throw new RangeError('Invalid encoded IP address.');
  if (length === 4) return [...buffer.subarray(offset, offset + 4)].join('.');
  const groups = [];
  for (let i = 0; i < 16; i += 2) groups.push(buffer.readUInt16BE(offset + i).toString(16));
  return groups.join(':');
}
function int2ip(ipInt) {
  return (
    (ipInt >>> 24) + '.' + ((ipInt >> 16) & 255) + '.' + ((ipInt >> 8) & 255) + '.' + (ipInt & 255)
  );
}
function ip2int(ip) {
  return (
    ip.split('.').reduce(function (ipInt, octet) {
      return (ipInt << 8) + parseInt(octet, 10);
    }, 0) >>> 0
  );
}

function UDPBind(onconnect, onmessage, onclose, v6) {
  // =====================
  if (typeof onmessage == 'object') {
    const pipeSocket = onmessage;
    onmessage = pipeSocket.write.bind(pipeSocket);
    onclose = pipeSocket.destroy.bind(pipeSocket);
    pipeSocket.on('error', close);
    pipeSocket.on('close', close);
    pipeSocket.on('data', message);
  }

  var dgramsocket;
  if (v6) {
    dgramsocket = dgram.createSocket('udp6');
  } else dgramsocket = dgram.createSocket('udp4');

  function close() {
    if (dgramsocket == null) return;
    dgramsocket.close();
    dgramsocket = null;
  }
  function message(buffer, p, h) {
    if (dgramsocket == null || !p || p <= 0 || p >= 65536) return;
    dgramsocket.send(buffer, p, h);
  }
  if (dgramsocket) {
    dgramsocket.on('error', close);
    dgramsocket.on('message', onmessage);
    // =====================
    const timeout = setTimeout(close, 10000);
    dgramsocket.on('close', function () {
      onclose();
      dgramsocket = null;
      clearTimeout(timeout);
    });
    dgramsocket.once('message', clearTimeout.bind(null, timeout));
    // =====================
    dgramsocket.bind(onconnect);
  } else onclose();
  return {
    close,
    message,
  };
}
module.exports = {
  ip4toBuffer,
  ip6toBuffer,
  iptoString,
  iptoBuffer,
  int2ip,
  ip2int,
  UDPBind,
};
