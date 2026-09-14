#!/usr/bin/env python3
"""Target-scoped cpolar transport for a verified physical interface.

DNS-over-HTTPS avoids a local TUN's synthetic DNS address. SSH still performs
its own strict host-key verification; this transport never reads credentials.
"""
import argparse
import ipaddress
import json
import os
import re
import socket
import sys
import urllib.parse
import urllib.request

def resolve_cpolar(host):
    if not re.fullmatch(r'[0-9]+\.tcp\.cpolar\.(top|cn)', host):
        raise ValueError('unsupported_cpolar_hostname')
    query = urllib.parse.urlencode({'name': host, 'type': 'A'})
    # A transport error may use one alternate HTTPS resolver. TLS/host-key
    # checks are never disabled and no process-wide proxy settings are changed.
    for resolver in ['https://dns.google/resolve', 'https://dns.alidns.com/resolve']:
        try:
            with urllib.request.urlopen(resolver + '?' + query, timeout=8) as response:
                data = json.loads(response.read(64 * 1024))
            if data.get('Status') != 0: continue
            addresses = [item['data'] for item in data.get('Answer', []) if item.get('type') == 1]
            for address in addresses:
                ip = ipaddress.ip_address(address)
                if ip.version == 4 and ip.is_global and ip not in ipaddress.ip_network('28.0.0.0/8'):
                    return str(ip)
        except (OSError, ValueError):
            continue
    raise ValueError('cpolar_public_address_missing')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--interface', required=True)
    parser.add_argument('--resolve-only', action='store_true')
    args = parser.parse_args()
    if sys.platform != 'darwin' or not 1 <= args.port <= 65535:
        raise ValueError('cpolar_transport_environment_invalid')
    socket.if_nametoindex(args.interface)
    address = resolve_cpolar(args.host)
    if args.resolve_only:
        print(json.dumps({'host': args.host, 'address': address, 'interface': args.interface}))
        return
    os.execv('/usr/bin/nc', ['/usr/bin/nc', '-4', '-G', '12', '-b', args.interface, address, str(args.port)])

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(f'cpolar transport failed: {error}', file=sys.stderr)
        sys.exit(1)
