FROM alpine:3.21
RUN apk add --no-cache openconnect socat bash
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# Credentials come in as env vars at runtime — never baked into the image.
ENTRYPOINT ["/entrypoint.sh"]
