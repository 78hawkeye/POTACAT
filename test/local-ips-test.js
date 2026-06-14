// RemoteServer._isVirtualAdapter — the filter that decides which
// interfaces may be advertised as "the LAN" in pairing QRs, pair
// links, mDNS, and TLS cert SANs. K6RBJ's desktop advertised its
// ZeroTier overlay IP (unreachable from any phone) because the filter
// didn't know ZeroTier — and ZeroTier with default-route override
// also defeats the routed-address backstop.
// Run: node test/local-ips-test.js

'use strict';

const { RemoteServer } = require('../lib/remote-server');

let passed = 0, failed = 0;
function check(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ FAIL: ' + label); }
}
const virt = (name, mac) => RemoteServer._isVirtualAdapter(name, mac);

console.log('=== virtual adapter filter ===');

// Overlay VPNs (the K6RBJ class)
check(virt('ZeroTier One [d5e5fb6537869f6c]'), 'ZeroTier (Windows name)');
check(virt('zt7nnig26'), 'ZeroTier (Linux zt<hash>)');
check(virt('Hamachi'), 'LogMeIn Hamachi');
check(virt('WireGuard Tunnel #1'), 'WireGuard');
check(virt('wintun'), 'WinTun');
check(virt('OpenVPN TAP-Windows6'), 'OpenVPN');
check(virt('NordLynx'), 'NordLynx');

// Hypervisors / containers (existing coverage must not regress)
check(virt('vEthernet (Default Switch)'), 'Hyper-V vEthernet');
check(virt('VirtualBox Host-Only Network'), 'VirtualBox');
check(virt('VMware Network Adapter VMnet8'), 'VMware');
check(virt('docker0'), 'docker bridge');
check(virt('tun0'), 'tun0');
check(virt('Ethernet 3', '00:15:5D:01:02:03'), 'Hyper-V by MAC OUI');

// Real adapters must pass through
check(!virt('Ethernet'), 'plain Ethernet is NOT virtual');
check(!virt('Wi-Fi'), 'Wi-Fi is NOT virtual');
check(!virt('eth0'), 'eth0 is NOT virtual');
check(!virt('en0'), 'en0 (macOS) is NOT virtual');
check(!virt('Realtek Gaming 2.5GbE', '00:e0:4c:aa:bb:cc'), 'real Realtek NIC is NOT virtual');
// Names merely CONTAINING the letters must not false-positive
check(!virt('Intel(R) Ethernet Connection'), 'no false positive on ordinary names');

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
