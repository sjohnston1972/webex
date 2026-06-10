#!/bin/bash
# Connects to the dCloud AnyConnect VPN, then forwards local ports to lab
# hosts so other containers on the docker network (cloudflared) can reach
# them. Required env: VPN_URL, VPN_USERNAME, VPN_PASSWORD, CUCM_IP.
set -e

echo "[dcloud-vpn] connecting to ${VPN_URL} as ${VPN_USERNAME}…"
echo "${VPN_PASSWORD}" | openconnect \
  --protocol=anyconnect \
  --user="${VPN_USERNAME}" \
  --passwd-on-stdin \
  --non-inter \
  --background \
  --pid-file=/tmp/oc.pid \
  "${VPN_URL}"

# Wait for the tun interface to come up.
for i in $(seq 1 30); do
  ip addr show tun0 >/dev/null 2>&1 && break
  sleep 1
done
ip addr show tun0 >/dev/null 2>&1 || { echo "[dcloud-vpn] tun0 never appeared"; exit 1; }
echo "[dcloud-vpn] VPN up:"
ip -4 addr show tun0 | grep inet

echo "[dcloud-vpn] forwarding :8443 -> ${CUCM_IP}:8443 (CUCM AXL/admin)"
socat TCP-LISTEN:8443,fork,reuseaddr TCP:"${CUCM_IP}":8443 &

# Keep the container alive while the VPN process lives; die if it dies so
# docker restart policy reconnects us.
while kill -0 "$(cat /tmp/oc.pid)" 2>/dev/null; do sleep 5; done
echo "[dcloud-vpn] openconnect exited — container stopping for restart"
exit 1
